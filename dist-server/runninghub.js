import axios from 'axios';
import FormData from 'form-data';
// ============================================================
// RunningHub API Configuration
// ============================================================
const RUNNINGHUB_BASE_URL = 'https://www.runninghub.cn';
function getApiKey() {
    const apiKey = process.env.RUNNINGHUB_API_KEY;
    if (!apiKey) {
        throw new Error('RUNNINGHUB_API_KEY environment variable is not set');
    }
    return apiKey;
}
function getWebhookBaseUrl() {
    // Fly.io app public URL — used to construct webhook callback URL
    if (process.env.WEBHOOK_BASE_URL) {
        return process.env.WEBHOOK_BASE_URL;
    }
    if (process.env.FLY_APP_NAME) {
        return `https://${process.env.FLY_APP_NAME}.fly.dev`;
    }
    return 'https://douyin-down.fly.dev';
}
// ============================================================
// API Functions
// ============================================================
/**
 * Upload an image to RunningHub.
 * Downloads the image from the given URL first, then uploads to RunningHub.
 *
 * POST https://www.runninghub.cn/task/openapi/upload
 * Content-Type: multipart/form-data
 */
export async function uploadImage(imageUrl) {
    console.log('[RunningHub] Uploading image from URL:', imageUrl.substring(0, 100));
    // Step 1: Download the image from the source URL
    const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; PhotoRestoreBot/1.0)',
        },
    });
    const imageBuffer = Buffer.from(imageResponse.data);
    const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
    // Determine file extension from content type
    let ext = 'jpg';
    if (contentType.includes('png'))
        ext = 'png';
    else if (contentType.includes('webp'))
        ext = 'webp';
    else if (contentType.includes('gif'))
        ext = 'gif';
    // Step 2: Upload to RunningHub
    const form = new FormData();
    form.append('file', imageBuffer, {
        filename: `upload.${ext}`,
        contentType: contentType,
    });
    form.append('apiKey', getApiKey());
    form.append('fileType', 'image');
    const response = await axios.post(`${RUNNINGHUB_BASE_URL}/task/openapi/upload`, form, {
        headers: {
            ...form.getHeaders(),
        },
        timeout: 60000,
    });
    console.log('[RunningHub] Upload response:', JSON.stringify(response.data));
    if (response.data.code !== 0) {
        throw new Error(`Upload failed: ${response.data.msg || JSON.stringify(response.data)}`);
    }
    return {
        fileName: response.data.data?.fileName || response.data.data,
        fileType: response.data.data?.fileType || 'input',
    };
}
/**
 * Upload a file to RunningHub using the V2 binary upload API.
 * Accepts a raw file buffer (e.g. from multer) and uploads directly.
 * Returns both a public download URL and an internal fileName for workflow use.
 *
 * POST https://www.runninghub.cn/openapi/v2/media/upload/binary
 * Authorization: Bearer <API_KEY>
 * Content-Type: multipart/form-data
 *
 * Note: The returned download_url is valid for approximately 1 day.
 */
export async function uploadFileV2(fileBuffer, originalFilename, mimeType) {
    console.log('[RunningHub] V2 uploading file:', originalFilename, 'mimeType:', mimeType);
    const form = new FormData();
    form.append('file', fileBuffer, {
        filename: originalFilename,
        contentType: mimeType,
    });
    const response = await axios.post(`${RUNNINGHUB_BASE_URL}/openapi/v2/media/upload/binary`, form, {
        headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${getApiKey()}`,
        },
        timeout: 60000,
    });
    console.log('[RunningHub] V2 Upload response:', JSON.stringify(response.data));
    if (response.data.code !== 0) {
        throw new Error(`V2 Upload failed: ${response.data.message || JSON.stringify(response.data)}`);
    }
    const data = response.data.data;
    if (!data) {
        throw new Error('V2 Upload failed: empty response data');
    }
    return {
        type: data.type || 'image',
        downloadUrl: data.download_url,
        fileName: data.fileName,
        size: data.size || '0',
    };
}
/**
 * Create a task on RunningHub.
 * This submits the workflow with the uploaded image and a webhook URL.
 *
 * POST https://www.runninghub.cn/task/openapi/create
 */
export async function createTask(workflowId, nodeInfoList) {
    const webhookUrl = `${getWebhookBaseUrl()}/api/webhook/runninghub`;
    console.log('[RunningHub] Creating task, workflow:', workflowId, 'webhook:', webhookUrl);
    const requestBody = {
        apiKey: getApiKey(),
        workflowId: workflowId,
        nodeInfoList: nodeInfoList,
        webhookUrl: webhookUrl,
    };
    const response = await axios.post(`${RUNNINGHUB_BASE_URL}/task/openapi/create`, requestBody, {
        headers: {
            'Content-Type': 'application/json',
        },
        timeout: 30000,
    });
    console.log('[RunningHub] Create task response:', JSON.stringify(response.data));
    if (response.data.code !== 0) {
        throw new Error(`Create task failed: ${response.data.msg || JSON.stringify(response.data)}`);
    }
    return {
        taskId: response.data.data?.taskId || response.data.data,
        taskStatus: response.data.data?.taskStatus,
    };
}
/**
 * Query task outputs (fallback for when webhook doesn't fire).
 *
 * POST https://www.runninghub.cn/task/openapi/outputs
 */
export async function queryTaskOutputs(taskId) {
    console.log('[RunningHub] Querying task outputs for:', taskId);
    const response = await axios.post(`${RUNNINGHUB_BASE_URL}/task/openapi/outputs`, {
        apiKey: getApiKey(),
        taskId: taskId,
    }, {
        headers: {
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });
    console.log('[RunningHub] Query outputs response:', JSON.stringify(response.data));
    const data = response.data.data;
    const outputs = [];
    if (Array.isArray(data)) {
        for (const item of data) {
            outputs.push({
                fileUrl: item.fileUrl || item.output?.fileUrl,
                filename: item.filename || item.output?.filename,
                type: item.type || item.output?.type,
            });
        }
    }
    return {
        taskId: taskId,
        taskStatus: response.data.data?.taskStatus || (outputs.length > 0 ? 'SUCCESS' : 'UNKNOWN'),
        outputs: outputs,
    };
}
// ============================================================
// Business Logic Helpers
// ============================================================
/**
 * Photo Restore workflow configuration.
 * The workflowId and nodeInfoList are configured via environment variables.
 */
export function getPhotoRestoreConfig() {
    // The webapp/workflow ID for photo restoration — 老照片划痕清理终极版
    const workflowId = process.env.RUNNINGHUB_WEBAPP_ID_PHOTO_RESTORE || '1980901267709018114';
    // Workflow node mapping (from 老照片划痕清理终极版_api.json):
    // Node 248 (LoadImage)     — fieldName: "image"  — 上传的待修复照片
    // Node 190 (TextInput)     — fieldName: "text"   — 可选额外文本提示（默认为空）
    // Node 291 (孤海-浮点滑条)  — fieldName: "数值"   — CN强度，值越大变形越小，值越小移除越干净（默认0.4）
    // Node 292 (DF_Float)      — fieldName: "Value"  — 输出尺寸百万像素（默认1.6，约1024x1600）
    return {
        workflowId,
        // Primary image input node
        imageNodeId: '248',
        imageFieldName: 'image',
        // Optional text prompt node
        textNodeId: '190',
        textFieldName: 'text',
        // CN strength control node (0-1, lower = cleaner removal, higher = less deformation)
        cnStrengthNodeId: '291',
        cnStrengthFieldName: '数值',
        cnStrengthDefault: 0.4,
        // Output size in megapixels
        outputSizeNodeId: '292',
        outputSizeFieldName: 'Value',
        outputSizeDefault: 1.6,
    };
}
/**
 * Execute the full photo restoration flow:
 * 1. Upload image to RunningHub
 * 2. Create task with the uploaded image and optional parameters
 *
 * Returns the taskId for tracking.
 */
export async function submitPhotoRestore(imageUrl, options = {}) {
    // Step 1: Upload image
    const uploadResult = await uploadImage(imageUrl);
    console.log('[RunningHub] Image uploaded:', uploadResult.fileName);
    // Step 2: Build nodeInfoList from workflow configuration
    const config = getPhotoRestoreConfig();
    const nodeInfoList = [
        // Required: the image to restore
        {
            nodeId: config.imageNodeId,
            fieldName: config.imageFieldName,
            fieldValue: uploadResult.fileName,
        },
    ];
    // Optional: extra text prompt
    if (options.text !== undefined) {
        nodeInfoList.push({
            nodeId: config.textNodeId,
            fieldName: config.textFieldName,
            fieldValue: options.text,
        });
    }
    // Optional: CN strength
    const cnStrength = options.cnStrength ?? config.cnStrengthDefault;
    nodeInfoList.push({
        nodeId: config.cnStrengthNodeId,
        fieldName: config.cnStrengthFieldName,
        fieldValue: String(cnStrength),
    });
    // Optional: output size in megapixels
    const outputSize = options.outputSize ?? config.outputSizeDefault;
    nodeInfoList.push({
        nodeId: config.outputSizeNodeId,
        fieldName: config.outputSizeFieldName,
        fieldValue: String(outputSize),
    });
    console.log('[RunningHub] nodeInfoList:', JSON.stringify(nodeInfoList));
    // Step 3: Create task
    const taskResult = await createTask(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Task created:', taskResult.taskId);
    return taskResult.taskId;
}
// ============================================================
// Anime Conversion (真人转动漫) Workflow
// ============================================================
/**
 * Anime conversion workflow configuration.
 * The workflowId and nodeInfoList are configured via environment variables.
 *
 * Workflow node mapping (from 真人转动漫_api.json):
 * Node 425 (LoadImage)                — fieldName: "image"  — 上传的待转换真人照片
 * Node 447 (TextEncodeQwenImageEdit)  — fieldName: "prompt" — 正向提示词（默认"写实风格转漫画风格，唯美国漫风"）
 */
export function getAnimeConvertConfig() {
    // The webapp/workflow ID for anime conversion — 真人转动漫
    const workflowId = process.env.RUNNINGHUB_WEBAPP_ID_ANIME_CONVERT || '2059878371705843713';
    return {
        workflowId,
        // Primary image input node
        imageNodeId: '425',
        imageFieldName: 'image',
        // Prompt node for controlling anime style
        promptNodeId: '447',
        promptFieldName: 'prompt',
        promptDefault: '写实风格转漫画风格，唯美国漫风',
    };
}
/**
 * Execute the full anime conversion flow:
 * 1. Upload image to RunningHub
 * 2. Create task with the uploaded image and prompt
 *
 * Returns the taskId for tracking.
 */
export async function submitAnimeConvert(imageUrl, options = {}) {
    // Step 1: Upload image
    const uploadResult = await uploadImage(imageUrl);
    console.log('[RunningHub] Image uploaded for anime conversion:', uploadResult.fileName);
    // Step 2: Build nodeInfoList from workflow configuration
    const config = getAnimeConvertConfig();
    const nodeInfoList = [
        // Required: the image to convert
        {
            nodeId: config.imageNodeId,
            fieldName: config.imageFieldName,
            fieldValue: uploadResult.fileName,
        },
        // Prompt: controls the anime style
        {
            nodeId: config.promptNodeId,
            fieldName: config.promptFieldName,
            fieldValue: options.prompt ?? config.promptDefault,
        },
    ];
    console.log('[RunningHub] Anime convert nodeInfoList:', JSON.stringify(nodeInfoList));
    // Step 3: Create task
    const taskResult = await createTask(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Anime convert task created:', taskResult.taskId);
    return taskResult.taskId;
}
