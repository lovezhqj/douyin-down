import pg from 'pg';

const { Pool } = pg;

// ============================================================
// Database Connection Pool
// ============================================================
let pool: pg.Pool | null = null;

/**
 * Get the database connection pool (lazy initialization).
 * Reads DATABASE_URL from environment variables (set by `fly postgres attach`).
 */
function getPool(): pg.Pool {
    if (!pool) {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
            console.warn('[DB] DATABASE_URL not set — database features disabled');
            throw new Error('DATABASE_URL environment variable is not set');
        }
        pool = new Pool({
            connectionString: databaseUrl,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        pool.on('error', (err) => {
            console.error('[DB] Unexpected pool error:', err.message);
        });
    }
    return pool;
}

// ============================================================
// Query Helper
// ============================================================

/**
 * Execute a parameterized SQL query.
 */
export async function query(text: string, params?: any[]): Promise<pg.QueryResult> {
    const p = getPool();
    const start = Date.now();
    const result = await p.query(text, params);
    const duration = Date.now() - start;
    console.log(`[DB] Query (${duration}ms): ${text.substring(0, 80)}...`);
    return result;
}

// ============================================================
// Database Initialization — Create tables & indexes (idempotent)
// ============================================================

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ai_tasks (
    id              SERIAL PRIMARY KEY,
    openid          VARCHAR(128) NOT NULL,
    biz_code        VARCHAR(64)  NOT NULL,
    task_id         VARCHAR(128),
    status          VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
    input_image_url TEXT,
    output_data     JSONB,
    output_image_url TEXT,
    error_message   TEXT,
    webhook_received_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
`;

const CREATE_QUOTA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS quota_config (
    id              SERIAL PRIMARY KEY,
    biz_code        VARCHAR(64) UNIQUE NOT NULL,
    biz_name        VARCHAR(128) NOT NULL,
    daily_free_limit INTEGER NOT NULL DEFAULT 5,
    daily_max_limit  INTEGER NOT NULL DEFAULT 20,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const CREATE_INDEXES_SQL = [
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_openid_bizcode ON ai_tasks (openid, biz_code);`,
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_task_id ON ai_tasks (task_id);`,
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks (status);`,
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_created_at ON ai_tasks (created_at);`,
];

/** Default quota configuration for all business functions */
const DEFAULT_QUOTA_CONFIGS = [
    { bizCode: 'photo_restore', bizName: '老照片修复', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'anime_convert', bizName: '真人转动漫', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'voice_clone', bizName: '语音克隆', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'text_to_image', bizName: '全能文生图', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'text_to_speech', bizName: '文本转语音', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'remove_watermark', bizName: '图片去水印', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'image_to_video', bizName: '图生视频', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'video_transcript', bizName: '视频文案提取', dailyFreeLimit: 5, dailyMaxLimit: 20 },
    { bizCode: 'video_parse', bizName: '视频去水印', dailyFreeLimit: 5, dailyMaxLimit: 20 },
];

/**
 * Seed default quota configurations (idempotent — uses ON CONFLICT DO NOTHING).
 */
async function seedDefaultQuotaConfigs(): Promise<void> {
    for (const cfg of DEFAULT_QUOTA_CONFIGS) {
        await query(
            `INSERT INTO quota_config (biz_code, biz_name, daily_free_limit, daily_max_limit)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (biz_code) DO NOTHING`,
            [cfg.bizCode, cfg.bizName, cfg.dailyFreeLimit, cfg.dailyMaxLimit]
        );
    }
    console.log('[DB] Default quota configs seeded');
}

/**
 * Initialize the database: create tables and indexes.
 * This is idempotent and safe to call on every startup.
 */
export async function initDatabase(): Promise<void> {
    try {
        console.log('[DB] Initializing database...');
        await query(CREATE_TABLE_SQL);
        await query(CREATE_QUOTA_TABLE_SQL);
        for (const sql of CREATE_INDEXES_SQL) {
            await query(sql);
        }
        await seedDefaultQuotaConfigs();
        console.log('[DB] Database initialized successfully');
    } catch (err: any) {
        console.error('[DB] Database initialization failed:', err.message);
        // Don't crash the server — other endpoints still work without DB
    }
}

// ============================================================
// Task Data Access Functions
// ============================================================

export interface AiTask {
    id: number;
    openid: string;
    biz_code: string;
    task_id: string | null;
    status: string;
    input_image_url: string | null;
    output_data: any;
    output_image_url: string | null;
    error_message: string | null;
    webhook_received_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * Check if user has an active (PENDING or RUNNING) task for a given biz_code.
 */
export async function hasActiveTask(openid: string, bizCode: string): Promise<boolean> {
    const result = await query(
        `SELECT COUNT(*) AS cnt FROM ai_tasks WHERE openid = $1 AND biz_code = $2 AND status IN ('PENDING', 'RUNNING')`,
        [openid, bizCode]
    );
    return parseInt(result.rows[0].cnt, 10) > 0;
}

/**
 * Create a new task record.
 */
export async function createTask(
    openid: string,
    bizCode: string,
    taskId: string,
    inputImageUrl: string
): Promise<AiTask> {
    const result = await query(
        `INSERT INTO ai_tasks (openid, biz_code, task_id, status, input_image_url)
         VALUES ($1, $2, $3, 'PENDING', $4)
         RETURNING *`,
        [openid, bizCode, taskId, inputImageUrl]
    );
    return result.rows[0] as AiTask;
}

/**
 * Update task status and result data when webhook is received.
 */
export async function updateTaskByTaskId(
    taskId: string,
    status: string,
    outputData: any,
    outputImageUrl: string | null,
    errorMessage: string | null
): Promise<AiTask | null> {
    const result = await query(
        `UPDATE ai_tasks
         SET status = $2,
             output_data = $3,
             output_image_url = $4,
             error_message = $5,
             webhook_received_at = NOW(),
             updated_at = NOW()
         WHERE task_id = $1
         RETURNING *`,
        [taskId, status, JSON.stringify(outputData), outputImageUrl, errorMessage]
    );
    return result.rows.length > 0 ? (result.rows[0] as AiTask) : null;
}

/**
 * Get the latest task for a user + biz_code combination.
 */
export async function getLatestTask(openid: string, bizCode: string): Promise<AiTask | null> {
    const result = await query(
        `SELECT * FROM ai_tasks
         WHERE openid = $1 AND biz_code = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [openid, bizCode]
    );
    return result.rows.length > 0 ? (result.rows[0] as AiTask) : null;
}

/**
 * Get task by taskId.
 */
export async function getTaskByTaskId(taskId: string): Promise<AiTask | null> {
    const result = await query(
        `SELECT * FROM ai_tasks WHERE task_id = $1`,
        [taskId]
    );
    return result.rows.length > 0 ? (result.rows[0] as AiTask) : null;
}

/**
 * Update task status (e.g., from PENDING to RUNNING).
 */
export async function updateTaskStatus(taskId: string, status: string): Promise<void> {
    await query(
        `UPDATE ai_tasks SET status = $2, updated_at = NOW() WHERE task_id = $1`,
        [taskId, status]
    );
}

/**
 * Clean up stale tasks that have been PENDING or RUNNING for too long (over 30 minutes).
 * Mark them as FAILED to unblock the user.
 */
export async function cleanStaleTasks(): Promise<number> {
    const result = await query(
        `UPDATE ai_tasks
         SET status = 'FAILED',
             error_message = '任务超时，请重新提交',
             updated_at = NOW()
         WHERE status IN ('PENDING', 'RUNNING')
           AND created_at < NOW() - INTERVAL '30 minutes'
         RETURNING id`
    );
    return result.rowCount || 0;
}

// ============================================================
// Quota Configuration Data Access Functions
// ============================================================

export interface QuotaConfig {
    id: number;
    biz_code: string;
    biz_name: string;
    daily_free_limit: number;
    daily_max_limit: number;
    created_at: Date;
    updated_at: Date;
}

/**
 * Get the number of tasks a user has submitted today (UTC+8) for a given biz_code.
 * Counts ALL tasks regardless of status (PENDING, RUNNING, SUCCESS, FAILED).
 */
export async function getTodayUsageCount(openid: string, bizCode: string): Promise<number> {
    const result = await query(
        `SELECT COUNT(*) AS cnt FROM ai_tasks
         WHERE openid = $1 AND biz_code = $2
           AND created_at >= ((NOW() AT TIME ZONE 'Asia/Shanghai')::date || ' 00:00:00 Asia/Shanghai')::timestamptz`,
        [openid, bizCode]
    );
    return parseInt(result.rows[0].cnt, 10);
}

/**
 * Get quota configuration for a specific biz_code.
 */
export async function getQuotaConfig(bizCode: string): Promise<QuotaConfig | null> {
    const result = await query(
        `SELECT * FROM quota_config WHERE biz_code = $1`,
        [bizCode]
    );
    return result.rows.length > 0 ? (result.rows[0] as QuotaConfig) : null;
}

/**
 * Get all quota configurations.
 */
export async function getAllQuotaConfigs(): Promise<QuotaConfig[]> {
    const result = await query(
        `SELECT * FROM quota_config ORDER BY id ASC`
    );
    return result.rows as QuotaConfig[];
}

/**
 * Create or update a quota configuration.
 */
export async function upsertQuotaConfig(
    bizCode: string,
    bizName: string,
    dailyFreeLimit: number,
    dailyMaxLimit: number
): Promise<QuotaConfig> {
    const result = await query(
        `INSERT INTO quota_config (biz_code, biz_name, daily_free_limit, daily_max_limit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (biz_code)
         DO UPDATE SET biz_name = $2, daily_free_limit = $3, daily_max_limit = $4, updated_at = NOW()
         RETURNING *`,
        [bizCode, bizName, dailyFreeLimit, dailyMaxLimit]
    );
    return result.rows[0] as QuotaConfig;
}

/**
 * Get task statistics for the admin dashboard.
 * Returns total count and today's count for each biz_code.
 */
export async function getTaskStats(): Promise<Array<{
    biz_code: string;
    biz_name: string;
    total_count: number;
    today_count: number;
}>> {
    const result = await query(
        `SELECT
            qc.biz_code,
            qc.biz_name,
            COALESCE(total.cnt, 0)::int AS total_count,
            COALESCE(today.cnt, 0)::int AS today_count
         FROM quota_config qc
         LEFT JOIN (
            SELECT biz_code, COUNT(*) AS cnt
            FROM ai_tasks
            GROUP BY biz_code
         ) total ON total.biz_code = qc.biz_code
         LEFT JOIN (
            SELECT biz_code, COUNT(*) AS cnt
            FROM ai_tasks
            WHERE created_at >= ((NOW() AT TIME ZONE 'Asia/Shanghai')::date || ' 00:00:00 Asia/Shanghai')::timestamptz
            GROUP BY biz_code
         ) today ON today.biz_code = qc.biz_code
         ORDER BY qc.id ASC`
    );
    return result.rows;
}

