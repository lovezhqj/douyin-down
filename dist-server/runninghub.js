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
// ============================================================
// Voice Cloning (语音克隆) Workflow
// ============================================================
/**
 * Upload an audio file to RunningHub.
 * Downloads the audio from the given URL first, then uploads to RunningHub.
 *
 * POST https://www.runninghub.cn/task/openapi/upload
 * Content-Type: multipart/form-data
 */
export async function uploadAudio(audioUrl) {
    console.log('[RunningHub] Uploading audio from URL:', audioUrl.substring(0, 100));
    // Step 1: Download the audio from the source URL
    const audioResponse = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AudioCloneBot/1.0)',
        },
    });
    const audioBuffer = Buffer.from(audioResponse.data);
    const contentType = audioResponse.headers['content-type'] || 'audio/mpeg';
    // Determine file extension from content type
    let ext = 'mp3';
    if (contentType.includes('wav'))
        ext = 'wav';
    else if (contentType.includes('flac'))
        ext = 'flac';
    else if (contentType.includes('ogg'))
        ext = 'ogg';
    // Step 2: Upload to RunningHub
    const form = new FormData();
    form.append('file', audioBuffer, {
        filename: `upload.${ext}`,
        contentType: contentType,
    });
    form.append('apiKey', getApiKey());
    form.append('fileType', 'audio');
    const response = await axios.post(`${RUNNINGHUB_BASE_URL}/task/openapi/upload`, form, {
        headers: {
            ...form.getHeaders(),
        },
        timeout: 60000,
    });
    console.log('[RunningHub] Audio upload response:', JSON.stringify(response.data));
    if (response.data.code !== 0) {
        throw new Error(`Audio upload failed: ${response.data.msg || JSON.stringify(response.data)}`);
    }
    return {
        fileName: response.data.data?.fileName || response.data.data,
        fileType: response.data.data?.fileType || 'input',
    };
}
/**
 * Voice cloning workflow configuration.
 * The workflowId and nodeInfoList are configured via environment variables.
 *
 * Workflow node mapping (from IndexTTS2 1965684535247650818):
 * Node 9 (LoadAudio)        — fieldName: "audio"  — 上传的克隆参考音频
 * Node 6 (Text Multiline)   — fieldName: "text"   — 语音文本内容
 * Node 17 (CR Text)         — fieldName: "text"   — 情感描述（默认："害羞的"）
 * Node 1 (IndexTTS2Run)     — Model configurations (top_k, top_p, etc.)
 */
export function getVoiceCloneConfig() {
    // The webapp/workflow ID for Voice Cloning — IndexTTS2 ComfyUI workflow ID
    const workflowId = process.env.RUNNINGHUB_WORKFLOW_ID_VOICE_CLONE ||
        process.env.RUNNINGHUB_WEBAPP_ID_VOICE_CLONE ||
        '1965585853093396482';
    return {
        workflowId,
        // Reference audio node
        audioNodeId: '9',
        audioFieldName: 'audio',
        // Text prompt node
        textNodeId: '6',
        textFieldName: 'text',
        // Emotion node
        emotionNodeId: '17',
        emotionFieldName: 'text',
        emotionDefault: '害羞的',
    };
}
/**
 * Execute the full voice cloning flow:
 * 1. Upload reference audio to RunningHub
 * 2. Create task with the uploaded audio, text, and optional options
 *
 * Returns the taskId for tracking.
 */
export async function submitVoiceClone(audioUrl, text, options = {}) {
    // Step 1: Upload reference audio
    const uploadResult = await uploadAudio(audioUrl);
    console.log('[RunningHub] Reference audio uploaded for voice cloning:', uploadResult.fileName);
    // Step 2: Build nodeInfoList from workflow configuration
    const config = getVoiceCloneConfig();
    const nodeInfoList = [
        // Required: the audio to clone from
        {
            nodeId: config.audioNodeId,
            fieldName: config.audioFieldName,
            fieldValue: uploadResult.fileName,
        },
        // Required: the text to synthesize
        {
            nodeId: config.textNodeId,
            fieldName: config.textFieldName,
            fieldValue: text,
        },
        // Optional: emotion description
        {
            nodeId: config.emotionNodeId,
            fieldName: config.emotionFieldName,
            fieldValue: options.emotion ?? config.emotionDefault,
        },
    ];
    // Optional Node 1 model parameters
    if (options.topK !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'top_k', fieldValue: String(options.topK) });
    }
    if (options.topP !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'top_p', fieldValue: String(options.topP) });
    }
    if (options.temperature !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'temperature', fieldValue: String(options.temperature) });
    }
    if (options.numBeams !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'num_beams', fieldValue: String(options.numBeams) });
    }
    if (options.maxMelTokens !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'max_mel_tokens', fieldValue: String(options.maxMelTokens) });
    }
    if (options.maxTextTokensPerSentence !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'max_text_tokens_per_sentence', fieldValue: String(options.maxTextTokensPerSentence) });
    }
    if (options.emoAlpha !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'emo_alpha', fieldValue: String(options.emoAlpha) });
    }
    if (options.useEmoText !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'use_emo_text', fieldValue: String(options.useEmoText) });
    }
    if (options.useRandom !== undefined) {
        nodeInfoList.push({ nodeId: '1', fieldName: 'use_random', fieldValue: String(options.useRandom) });
    }
    console.log('[RunningHub] Voice clone nodeInfoList:', JSON.stringify(nodeInfoList));
    // Step 3: Create task
    const taskResult = await createTask(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Voice clone task created:', taskResult.taskId);
    return taskResult.taskId;
}
// ============================================================
// Almighty Text-to-Image (全能文生图) Workflow
// ============================================================
/**
 * Text-to-Image workflow configuration.
 * The workflowId and nodeInfoList are configured via environment variables.
 *
 * Workflow node mapping (from 全能图片G-2.0-文生图_api.json):
 * Node 18 (RH_RhartImageG2TextToImage)
 * - fieldName: "prompt"      - 提示词
 * - fieldName: "aspectRatio" - 宽高比 (默认 1:1, or 4:3 etc.)
 * - fieldName: "resolution"  - 分辨率 (默认 1k)
 * - fieldName: "seed"        - 随机种子 (数字, 默认随机)
 * - fieldName: "skip_error"  - 跳过错误 (默认 false)
 */
export function getTextToImageConfig() {
    // The webapp/workflow ID for Almighty Text-to-Image — 全能图片G-2.0-文生图
    const workflowId = process.env.RUNNINGHUB_WEBAPP_ID_TEXT_TO_IMAGE || '2046775087558299649';
    return {
        workflowId,
        textToImageNodeId: '18',
        promptFieldName: 'prompt',
        aspectRatioFieldName: 'aspectRatio',
        aspectRatioDefault: '1:1',
        resolutionFieldName: 'resolution',
        resolutionDefault: '1k',
        seedFieldName: 'seed',
        skipErrorFieldName: 'skip_error',
        skipErrorDefault: false,
    };
}
/**
 * Execute the full text-to-image flow:
 * 1. Create task with prompt and options
 *
 * Returns the taskId for tracking.
 */
export async function submitTextToImage(options) {
    const config = getTextToImageConfig();
    const nodeInfoList = [
        // Required: prompt
        {
            nodeId: config.textToImageNodeId,
            fieldName: config.promptFieldName,
            fieldValue: options.prompt,
        },
    ];
    // Optional: aspect ratio
    if (options.aspectRatio !== undefined) {
        nodeInfoList.push({
            nodeId: config.textToImageNodeId,
            fieldName: config.aspectRatioFieldName,
            fieldValue: options.aspectRatio,
        });
    }
    // Optional: resolution
    if (options.resolution !== undefined) {
        nodeInfoList.push({
            nodeId: config.textToImageNodeId,
            fieldName: config.resolutionFieldName,
            fieldValue: options.resolution,
        });
    }
    // Optional: seed
    const seed = options.seed !== undefined && options.seed >= 0
        ? options.seed
        : Math.floor(Math.random() * 1000000000);
    nodeInfoList.push({
        nodeId: config.textToImageNodeId,
        fieldName: config.seedFieldName,
        fieldValue: String(seed),
    });
    // Optional: skip error
    if (options.skipError !== undefined) {
        nodeInfoList.push({
            nodeId: config.textToImageNodeId,
            fieldName: config.skipErrorFieldName,
            fieldValue: String(options.skipError),
        });
    }
    console.log('[RunningHub] Text to Image nodeInfoList:', JSON.stringify(nodeInfoList));
    // Create task
    const taskResult = await createTask(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Text to Image task created:', taskResult.taskId);
    return taskResult.taskId;
}
// ============================================================
// Text-to-Speech (文本转语音) Workflow
// ============================================================
/**
 * Text-to-Speech workflow configuration.
 * The workflowId and nodeInfoList are configured via environment variables.
 *
 * Workflow node mapping (from 文本转语音(含声音设计) Qwen3TTS 千问 2017058834166059009):
 * Node 99 (Text Multiline)     - fieldName: "text"  - 朗读文本
 * Node 100 (Text Multiline)    - fieldName: "text"  - 音色描述
 * Node 86 (Qwen3TTSVoiceDesign) - fieldName: "语言"  - 语言 (自动, 中文, 英文, 等)
 */
export function getTextToSpeechConfig() {
    const workflowId = process.env.RUNNINGHUB_WEBAPP_ID_TEXT_TO_SPEECH || '2017058834166059009';
    return {
        workflowId,
        textNodeId: '99',
        textFieldName: 'text',
        voiceDescriptionNodeId: '100',
        voiceDescriptionFieldName: 'text',
        voiceDescriptionDefault: '萝莉少女声音',
        languageNodeId: '86',
        languageFieldName: '语言',
        languageDefault: '自动',
    };
}
/**
 * Create an AI App task on RunningHub using the V2 API.
 * This submits the workflow with the parameters and a webhook URL.
 *
 * POST https://www.runninghub.cn/openapi/v2/run/ai-app/{webappId}
 * Authorization: Bearer <API_KEY>
 */
export async function createTaskV2(workflowId, nodeInfoList) {
    const webhookUrl = `${getWebhookBaseUrl()}/api/webhook/runninghub`;
    console.log('[RunningHub] Creating V2 task, workflow:', workflowId, 'webhook:', webhookUrl);
    const requestBody = {
        nodeInfoList: nodeInfoList,
        webhookUrl: webhookUrl,
    };
    const response = await axios.post(`${RUNNINGHUB_BASE_URL}/openapi/v2/run/ai-app/${workflowId}`, requestBody, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getApiKey()}`,
        },
        timeout: 30000,
    });
    console.log('[RunningHub] Create V2 task response:', JSON.stringify(response.data));
    const taskId = response.data?.taskId || response.data?.task_id || response.data?.data?.taskId || response.data?.data?.task_id;
    if (!taskId) {
        throw new Error(`Create V2 task failed: ${response.data?.message || response.data?.msg || JSON.stringify(response.data)}`);
    }
    return {
        taskId: taskId,
        taskStatus: response.data?.status || response.data?.taskStatus || response.data?.data?.taskStatus || response.data?.data?.status,
    };
}
/**
 * Execute the full text-to-speech flow:
 * 1. Create task with text and options via V2 run/ai-app API
 *
 * Returns the taskId for tracking.
 */
export async function submitTextToSpeech(options) {
    const config = getTextToSpeechConfig();
    const nodeInfoList = [
        // Required: text to synthesize
        {
            nodeId: config.textNodeId,
            fieldName: config.textFieldName,
            fieldValue: options.text,
        },
        // Optional: voice description
        {
            nodeId: config.voiceDescriptionNodeId,
            fieldName: config.voiceDescriptionFieldName,
            fieldValue: options.voiceDescription ?? config.voiceDescriptionDefault,
        },
        // Optional: language
        {
            nodeId: config.languageNodeId,
            fieldName: config.languageFieldName,
            fieldValue: options.language ?? config.languageDefault,
        },
    ];
    console.log('[RunningHub] Text to Speech nodeInfoList:', JSON.stringify(nodeInfoList));
    // Create task using the V2 openapi endpoint
    const taskResult = await createTaskV2(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Text to Speech task created:', taskResult.taskId);
    return taskResult.taskId;
}
// ============================================================
// Watermark Removal (图片去水印) Workflow
// ============================================================
/**
 * Watermark removal workflow configuration.
 * The workflowId and nodeInfoList are configured via environment variables.
 */
export function getWatermarkRemovalConfig() {
    // The webapp/workflow ID for Watermark Removal — 图片去水印 无损一键去水印 图片越大时间越长
    const workflowId = process.env.RUNNINGHUB_WEBAPP_ID_WATERMARK_REMOVAL || '2030295308986486786';
    return {
        workflowId,
        // Primary image input node
        imageNodeId: '191',
        imageFieldName: 'image',
    };
}
/**
 * Execute the full watermark removal flow:
 * 1. Upload image to RunningHub
 * 2. Create task V2 with the uploaded image
 *
 * Returns the taskId for tracking.
 */
export async function submitWatermarkRemoval(imageUrl) {
    // Step 1: Upload image
    const uploadResult = await uploadImage(imageUrl);
    console.log('[RunningHub] Image uploaded for watermark removal:', uploadResult.fileName);
    // Step 2: Build nodeInfoList from workflow configuration
    const config = getWatermarkRemovalConfig();
    const nodeInfoList = [
        // Required: the image to process
        {
            nodeId: config.imageNodeId,
            fieldName: config.imageFieldName,
            fieldValue: uploadResult.fileName,
        },
    ];
    console.log('[RunningHub] Watermark removal nodeInfoList:', JSON.stringify(nodeInfoList));
    // Step 3: Create task using V2 API
    const taskResult = await createTaskV2(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Watermark removal task created:', taskResult.taskId);
    return taskResult.taskId;
}
// ============================================================
// Image-to-Video (图生视频 Wan2.2) Workflow
// ============================================================
/**
 * Image-to-Video workflow configuration (Wan2.2 I2V).
 * The workflowId and nodeInfoList are configured via environment variables.
 *
 * Workflow node mapping (from wan2.2图生视频_api.json):
 * Node 114 (LoadImage)              — fieldName: "image"            — 上传的参考图片
 * Node 154 (WanVideoTextEncode)     — fieldName: "positive_prompt"  — 正向提示词
 * Node 154 (WanVideoTextEncode)     — fieldName: "negative_prompt"  — 负向提示词
 * Node 112 (Int)                    — fieldName: "value"            — 最大分辨率（默认912）
 * Node 125 (Int)                    — fieldName: "value"            — 秒数（默认5）
 * Node 124 (Int)                    — fieldName: "value"            — 帧率（默认16）
 * Node 144 (WanVideoSampler)        — fieldName: "seed"             — 随机种子
 */
export function getImageToVideoConfig() {
    // The webapp/workflow ID for Image-to-Video — wan2.2 图生视频
    const workflowId = process.env.RUNNINGHUB_WEBAPP_ID_IMAGE_TO_VIDEO || '1893899363629051906';
    return {
        workflowId,
        // Primary image input node
        imageNodeId: '114',
        imageFieldName: 'image',
        // Text prompts node
        textEncodeNodeId: '154',
        positivePromptFieldName: 'positive_prompt',
        positivePromptDefault: '这个年轻女人站了起来，抬起双手转圈转身旋转，镜头拉近人物的五官，镜头全程跟随',
        negativePromptFieldName: 'negative_prompt',
        negativePromptDefault: '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走',
        // Max resolution node
        maxResolutionNodeId: '112',
        maxResolutionFieldName: 'value',
        maxResolutionDefault: 912,
        // Duration in seconds node
        durationNodeId: '125',
        durationFieldName: 'value',
        durationDefault: 5,
        // Frame rate node
        frameRateNodeId: '124',
        frameRateFieldName: 'value',
        frameRateDefault: 16,
        // Seed node (WanVideoSampler)
        seedNodeId: '144',
        seedFieldName: 'seed',
    };
}
/**
 * Execute the full image-to-video flow:
 * 1. Upload image to RunningHub
 * 2. Create task with the uploaded image, prompts, and parameters via V2 API
 *
 * Returns the taskId for tracking.
 */
export async function submitImageToVideo(imageUrl, options = {}) {
    // Step 1: Upload image
    const uploadResult = await uploadImage(imageUrl);
    console.log('[RunningHub] Image uploaded for image-to-video:', uploadResult.fileName);
    // Step 2: Build nodeInfoList from workflow configuration
    const config = getImageToVideoConfig();
    const nodeInfoList = [
        // Required: the input image
        {
            nodeId: config.imageNodeId,
            fieldName: config.imageFieldName,
            fieldValue: uploadResult.fileName,
        },
        // Positive prompt
        {
            nodeId: config.textEncodeNodeId,
            fieldName: config.positivePromptFieldName,
            fieldValue: options.positivePrompt ?? config.positivePromptDefault,
        },
        // Negative prompt
        {
            nodeId: config.textEncodeNodeId,
            fieldName: config.negativePromptFieldName,
            fieldValue: options.negativePrompt ?? config.negativePromptDefault,
        },
    ];
    // Optional: max resolution
    const maxResolution = options.maxResolution ?? config.maxResolutionDefault;
    nodeInfoList.push({
        nodeId: config.maxResolutionNodeId,
        fieldName: config.maxResolutionFieldName,
        fieldValue: String(maxResolution),
    });
    // Optional: duration in seconds
    const duration = options.duration ?? config.durationDefault;
    nodeInfoList.push({
        nodeId: config.durationNodeId,
        fieldName: config.durationFieldName,
        fieldValue: String(duration),
    });
    // Optional: frame rate
    const frameRate = options.frameRate ?? config.frameRateDefault;
    nodeInfoList.push({
        nodeId: config.frameRateNodeId,
        fieldName: config.frameRateFieldName,
        fieldValue: String(frameRate),
    });
    // Optional: seed
    const seed = options.seed !== undefined && options.seed >= 0
        ? options.seed
        : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    nodeInfoList.push({
        nodeId: config.seedNodeId,
        fieldName: config.seedFieldName,
        fieldValue: String(seed),
    });
    console.log('[RunningHub] Image to Video nodeInfoList:', JSON.stringify(nodeInfoList));
    // Step 3: Create task using V1 API (服务端调用 apiType=5)
    const taskResult = await createTask(config.workflowId, nodeInfoList);
    console.log('[RunningHub] Image to Video task created:', taskResult.taskId);
    return taskResult.taskId;
}
