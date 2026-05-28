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

const CREATE_INDEXES_SQL = [
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_openid_bizcode ON ai_tasks (openid, biz_code);`,
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_task_id ON ai_tasks (task_id);`,
    `CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks (status);`,
];

/**
 * Initialize the database: create tables and indexes.
 * This is idempotent and safe to call on every startup.
 */
export async function initDatabase(): Promise<void> {
    try {
        console.log('[DB] Initializing database...');
        await query(CREATE_TABLE_SQL);
        for (const sql of CREATE_INDEXES_SQL) {
            await query(sql);
        }
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
