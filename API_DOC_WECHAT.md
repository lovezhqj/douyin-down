# 微信小程序端 - AI 图像处理接口调用文档

> 本文档提供微信小程序端调用 AI 图像处理相关接口（老照片修复、真人转动漫等）的完整说明。

---

## 目录

1. [接口总览](#接口总览)
2. [接口详情](#接口详情)
   - [微信登录](#1-微信登录)
   - [文件上传](#2-文件上传)
   - [发起老照片修复](#3-发起老照片修复)
   - [发起真人转动漫](#4-发起真人转动漫)
   - [查询任务结果](#5-查询任务结果)
3. [调用流程说明](#调用流程说明)
4. [bizCode 业务代码说明](#bizcode-业务代码说明)
5. [错误码说明](#错误码说明)
6. [微信小程序代码示例](#微信小程序代码示例)
7. [常见问题](#常见问题)

---

## 接口总览

| 接口 | Method | URL | 说明 |
|------|--------|-----|------|
| 微信登录 | `POST` | `/api/wechat/login` | 小程序登录，code 换取 openid |
| 文件上传 | `POST` | `/api/upload` | 上传文件到服务器，返回公网可访问的 URL |
| 发起老照片修复 | `POST` | `/api/photo/restore` | 提交照片修复任务（异步处理） |
| 发起真人转动漫 | `POST` | `/api/photo/anime` | 提交真人转动漫任务（异步处理） |
| 查询任务结果 | `GET` | `/api/photo/result` | 查询最新任务的处理状态和结果 |

**Base URL**: `https://douyin-down.fly.dev`

> [!IMPORTANT]
> 请将 Base URL 替换为你们实际的 Fly.io 应用域名。如果有自定义域名，使用自定义域名。

---

## 接口详情

### 1. 微信登录

**POST** `/api/wechat/login`

微信小程序登录接口。接受小程序端通过 `wx.login` 获取的临时登录凭证 code，服务端调用微信 `jscode2session` 接口换取用户的 openid。

> [!NOTE]
> 此接口封装了微信登录的完整流程，前端只需调用 `wx.login` 获取 code，然后传给此接口即可。服务端会安全地保管 AppSecret，不会将 `session_key` 返回给前端。

#### 请求头

```
Content-Type: application/json
```

#### 请求参数 (JSON Body)

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `code` | string | ✅ | 微信小程序 `wx.login` 返回的临时登录凭证 |

#### 请求示例

```json
{
  "code": "0a3Xyz000abc12def345"
}
```

#### 响应 - 成功 (200)

```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "openid": "oABC123456789"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `openid` | string | 用户在当前小程序的唯一标识 |
| `unionid` | string | 可选。只有在小程序绑定了微信开放平台时才会返回 |

> [!TIP]
> 获取到的 `openid` 需要在前端缓存（如存入 `globalData` 或本地缓存），后续调用其他接口（如老照片修复）时需要传入该值。

#### 响应 - 参数错误 (400)

```json
{
  "success": false,
  "error": "code 参数必填"
}
```

```json
{
  "success": false,
  "error": "code 无效或已过期，请重新调用 wx.login",
  "errcode": 40029
}
```

#### 响应 - 服务器错误 (500)

```json
{
  "success": false,
  "error": "微信登录失败：具体错误信息"
}
```

> [!IMPORTANT]
> **服务端环境变量配置**：使用此接口需要在服务端配置以下环境变量：
> - `WECHAT_APPID` — 微信小程序的 AppID
> - `WECHAT_SECRET` — 微信小程序的 AppSecret
>
> 可通过 [微信公众平台](https://mp.weixin.qq.com/) → 开发管理 → 开发设置 获取。

---

### 2. 文件上传

**POST** `/api/upload`

上传文件到服务器（内部转发至 RunningHub），返回公网可访问的下载链接。该链接可直接用于后续接口（如老照片修复）的 `imageUrl` 参数。

> [!IMPORTANT]
> 此接口替代了之前需要自行上传到 OSS/COS 的步骤。小程序用户可以直接通过 `wx.uploadFile` 上传照片到此接口。

#### 请求头

```
Content-Type: multipart/form-data
```

#### 请求参数 (Form Data)

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `file` | File | ✅ | 要上传的文件（支持 JPG/PNG/JPEG/WEBP/GIF 图片，MP3/WAV/FLAC 音频，MP4/AVI/MOV/MKV 视频，ZIP 压缩包） |

#### 文件限制

- 最大文件大小：**10MB**
- 支持的图片格式：JPG、PNG、JPEG、WEBP、GIF
- 支持的音频格式：MP3、WAV、FLAC
- 支持的视频格式：MP4、AVI、MOV、MKV
- 支持的压缩包格式：ZIP

#### 响应 - 成功 (200)

```json
{
  "success": true,
  "message": "文件上传成功",
  "data": {
    "downloadUrl": "https://rh-images-switch-xxx.cos.ap-guangzhou.myqcloud.com/input/openapi/xxx.png?q-sign-algorithm=sha1&...",
    "fileName": "openapi/xxx.png",
    "type": "image",
    "size": "123456"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `downloadUrl` | string | 公网可访问的下载链接（**有效期约1天**），可用作 `imageUrl` 参数 |
| `fileName` | string | RunningHub 内部文件名，用于工作流节点 |
| `type` | string | 文件类型，如 `image`、`video`、`audio` |
| `size` | string | 文件大小（字节） |

> [!WARNING]
> `downloadUrl` 有效期约为 **1天**。请在上传后尽快使用该链接调用后续接口（如老照片修复）。过期后需重新上传。

#### 响应 - 参数错误 (400)

```json
{
  "success": false,
  "error": "请上传文件（字段名: file）"
}
```

```json
{
  "success": false,
  "error": "文件大小超过限制（最大 10MB）"
}
```

```json
{
  "success": false,
  "error": "不支持的文件类型: application/pdf"
}
```

#### 响应 - 服务器错误 (500)

```json
{
  "success": false,
  "error": "文件上传失败：具体错误信息"
}
```

---

### 3. 发起老照片修复

**POST** `/api/photo/restore`

发起一个老照片修复任务。任务会异步处理，不会立即返回结果。

#### 请求头

```
Content-Type: application/json
```

#### 请求参数 (JSON Body)

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `openid` | string | ✅ | 微信用户的 openid |
| `bizCode` | string | ✅ | 业务代码，老照片修复固定为 `photo_restore` |
| `imageUrl` | string | ✅ | 待修复照片的 URL（需公网可访问的 http/https 链接） |
| `cnStrength` | number | ❌ | CN强度，0~1之间。值越小划痕移除越干净，值越大照片变形越小。默认 `0.4` |
| `outputSize` | number | ❌ | 输出尺寸（百万像素）。默认 `1.6`（约1024×1600） |

#### 请求示例

```json
{
  "openid": "oABC123456789",
  "bizCode": "photo_restore",
  "imageUrl": "https://your-oss.com/photos/old-photo.jpg"
}
```

#### 响应 - 成功 (200)

```json
{
  "success": true,
  "message": "任务已提交，正在后台处理中，请稍后查询结果",
  "data": {
    "taskId": "rh_task_1234567890",
    "status": "PENDING"
  }
}
```

#### 响应 - 有正在处理的任务 (409)

```json
{
  "success": false,
  "error": "您有一个正在处理中的任务，请等待处理完成后再次提交"
}
```

> [!WARNING]
> **并发限制**：同一用户（openid）+ 同一业务代码（bizCode）只能有一个进行中的任务。必须等上一个任务完成（SUCCESS 或 FAILED）后才能再次提交。

#### 响应 - 参数错误 (400)

```json
{
  "success": false,
  "error": "openid 参数必填"
}
```

#### 响应 - 服务器错误 (500)

```json
{
  "success": false,
  "error": "提交任务失败：具体错误信息"
}
```

---

### 4. 发起真人转动漫

**POST** `/api/photo/anime`

发起一个真人转动漫任务。将真人照片转换为动漫风格。任务会异步处理，不会立即返回结果。

#### 请求头

```
Content-Type: application/json
```

#### 请求参数 (JSON Body)

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `openid` | string | ✅ | 微信用户的 openid |
| `bizCode` | string | ✅ | 业务代码，真人转动漫固定为 `anime_convert` |
| `imageUrl` | string | ✅ | 待转换照片的 URL（需公网可访问的 http/https 链接） |
| `prompt` | string | ❌ | 风格提示词。默认 `"写实风格转漫画风格，唯美国漫风"` |

#### 请求示例

```json
{
  "openid": "oABC123456789",
  "bizCode": "anime_convert",
  "imageUrl": "https://your-oss.com/photos/portrait.jpg"
}
```

带自定义风格提示词的请求示例：

```json
{
  "openid": "oABC123456789",
  "bizCode": "anime_convert",
  "imageUrl": "https://your-oss.com/photos/portrait.jpg",
  "prompt": "写实风格转日系动漫风格，宫崎骏风"
}
```

#### 响应 - 成功 (200)

```json
{
  "success": true,
  "message": "任务已提交，正在后台处理中，请稍后查询结果",
  "data": {
    "taskId": "rh_task_1234567890",
    "status": "PENDING"
  }
}
```

#### 响应 - 有正在处理的任务 (409)

```json
{
  "success": false,
  "error": "您有一个正在处理中的任务，请等待处理完成后再次提交"
}
```

> [!WARNING]
> **并发限制**：同一用户（openid）+ 同一业务代码（bizCode）只能有一个进行中的任务。必须等上一个任务完成（SUCCESS 或 FAILED）后才能再次提交。

#### 响应 - 参数错误 (400)

```json
{
  "success": false,
  "error": "openid 参数必填"
}
```

#### 响应 - 服务器错误 (500)

```json
{
  "success": false,
  "error": "提交任务失败：具体错误信息"
}
```

> [!TIP]
> 真人转动漫只需传入一张清晰的人物照片即可，无需额外参数。建议使用正面、光线充足的照片以获得最佳效果。

---

### 5. 查询任务结果

**GET** `/api/photo/result`

查询指定用户和业务类型下最新一条任务的处理状态和结果。

#### 请求参数 (Query String)

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `openid` | string | ✅ | 微信用户的 openid |
| `bizCode` | string | ✅ | 业务代码，如 `photo_restore` |

#### 请求示例

```
GET /api/photo/result?openid=oABC123456789&bizCode=photo_restore
```

#### 响应 - 没有任务记录

```json
{
  "success": true,
  "data": {
    "status": "NONE",
    "message": "没有找到相关任务记录"
  }
}
```

#### 响应 - 任务排队中

```json
{
  "success": true,
  "data": {
    "status": "PENDING",
    "taskId": "rh_task_1234567890",
    "message": "任务已提交，正在排队中...",
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:00:00.000Z"
  }
}
```

#### 响应 - 任务处理中

```json
{
  "success": true,
  "data": {
    "status": "RUNNING",
    "taskId": "rh_task_1234567890",
    "message": "任务正在处理中，请稍后再查询",
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:00:05.000Z"
  }
}
```

#### 响应 - 任务成功 ✅

```json
{
  "success": true,
  "data": {
    "status": "SUCCESS",
    "taskId": "rh_task_1234567890",
    "message": "任务处理完成",
    "outputImageUrl": "https://runninghub.cn/output/restored-photo.png",
    "inputImageUrl": "https://your-oss.com/photos/old-photo.jpg",
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:01:30.000Z"
  }
}
```

> [!TIP]
> `outputImageUrl` 是修复后的照片 URL，可以直接用于 `<image>` 标签显示或下载。注意该 URL 可能有时效性，建议获取后及时下载保存。

#### 响应 - 任务失败 ❌

```json
{
  "success": true,
  "data": {
    "status": "FAILED",
    "taskId": "rh_task_1234567890",
    "message": "任务处理失败",
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:01:00.000Z"
  }
}
```

---

## 调用流程说明

```
┌─────────────────────┐
│  用户打开小程序       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  wx.login 获取 code  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  调用 POST              │
│  /api/wechat/login    │  (传入 code，获取 openid)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  用户选择/拍照老照片  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  调用 POST           │
│  /api/upload         │  (上传照片文件，获取公网 downloadUrl)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  调用 POST           │
│  /api/photo/restore  │  (传入 openid, bizCode, imageUrl=downloadUrl)
└─────────┬───────────┘
          │
          ▼
    ┌─────────────┐
    │ 返回 success │─── 显示"处理中"提示，引导用户稍后查看
    └─────────────┘
          │
          │  (用户等待，可设置定时轮询或用户手动刷新)
          ▼
┌─────────────────────┐
│  调用 GET            │
│  /api/photo/result   │  (传入 openid, bizCode)
└─────────┬───────────┘
          │
          ▼
    ┌─────────────┐
    │ status 判断  │
    ├─────────────┤
    │ PENDING     │─── 显示"排队中..."
    │ RUNNING     │─── 显示"处理中..."
    │ SUCCESS     │─── 显示修复后的照片 (outputImageUrl)
    │ FAILED      │─── 显示错误信息，可重新提交
    │ NONE        │─── 无任务记录
    └─────────────┘
```

### 推荐的轮询策略

提交任务成功后，建议小程序端使用以下轮询策略查询结果：

1. 提交成功后等待 **5 秒**，发起第一次查询
2. 如果还未完成，每隔 **5 秒**查询一次
3. 最多轮询 **60 次**（共约 5 分钟）
4. 超过 5 分钟仍未完成，提示用户"处理超时，请稍后手动查询"

---

## bizCode 业务代码说明

| bizCode | 说明 | 状态 |
|---------|------|------|
| `photo_restore` | 老照片修复 | ✅ 已上线 |
| `anime_convert` | 真人转动漫 | ✅ 已上线 |
| `photo_expand` | 照片扩图 | 🔜 计划中 |
| `photo_colorize` | 黑白照片上色 | 🔜 计划中 |

> [!NOTE]
> `bizCode` 用于区分不同的业务场景。不同业务之间的并发限制是独立的。即用户可以同时进行一个老照片修复和一个真人转动漫任务。

---

## 错误码说明

| HTTP 状态码 | success | 说明 |
|-------------|---------|------|
| 200 | true | 请求成功 |
| 400 | false | 参数错误（缺少必填参数或格式不正确） |
| 409 | false | 有正在处理中的同类任务，需等待完成 |
| 500 | false | 服务器内部错误 |

---

## 微信小程序代码示例

### 封装请求工具

```javascript
// utils/api.js

const BASE_URL = 'https://douyin-down.fly.dev';

/**
 * 微信登录，获取 openid
 * @returns {Promise<object>} - 返回 { openid, unionid? }
 */
export function wechatLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(loginRes) {
        if (!loginRes.code) {
          reject(new Error('wx.login 获取 code 失败'));
          return;
        }

        wx.request({
          url: `${BASE_URL}/api/wechat/login`,
          method: 'POST',
          header: {
            'Content-Type': 'application/json',
          },
          data: {
            code: loginRes.code,
          },
          success(res) {
            if (res.statusCode === 200 && res.data.success) {
              resolve(res.data.data);
            } else {
              reject(new Error(res.data.error || '登录失败'));
            }
          },
          fail(err) {
            reject(new Error('登录网络请求失败'));
          },
        });
      },
      fail() {
        reject(new Error('wx.login 调用失败'));
      },
    });
  });
}

/**
 * 上传文件到服务器
 * @param {string} filePath - 微信本地临时文件路径
 * @returns {Promise<object>} - 返回 { downloadUrl, fileName, type, size }
 */
export function uploadFile(filePath) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${BASE_URL}/api/upload`,
      filePath: filePath,
      name: 'file',
      success(res) {
        // wx.uploadFile 返回的 data 是字符串，需要解析
        let data;
        try {
          data = JSON.parse(res.data);
        } catch (e) {
          reject(new Error('服务器返回数据格式错误'));
          return;
        }

        if (res.statusCode === 200 && data.success) {
          resolve(data.data);
        } else {
          reject(new Error(data.error || '上传失败'));
        }
      },
      fail(err) {
        reject(new Error('文件上传网络请求失败'));
      },
    });
  });
}

/**
 * 发起老照片修复
 * @param {string} openid - 微信用户 openid
 * @param {string} imageUrl - 待修复照片的公网 URL（从 uploadFile 返回的 downloadUrl）
 * @returns {Promise<object>}
 */
export function submitPhotoRestore(openid, imageUrl) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}/api/photo/restore`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
      },
      data: {
        openid: openid,
        bizCode: 'photo_restore',
        imageUrl: imageUrl,
      },
      success(res) {
        if (res.statusCode === 200 && res.data.success) {
          resolve(res.data);
        } else if (res.statusCode === 409) {
          reject(new Error(res.data.error || '有正在处理中的任务'));
        } else {
          reject(new Error(res.data.error || '提交失败'));
        }
      },
      fail(err) {
        reject(new Error('网络请求失败'));
      },
    });
  });
}

/**
 * 发起真人转动漫
 * @param {string} openid - 微信用户 openid
 * @param {string} imageUrl - 待转换照片的公网 URL（从 uploadFile 返回的 downloadUrl）
 * @returns {Promise<object>}
 */
export function submitAnimeConvert(openid, imageUrl) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}/api/photo/anime`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
      },
      data: {
        openid: openid,
        bizCode: 'anime_convert',
        imageUrl: imageUrl,
      },
      success(res) {
        if (res.statusCode === 200 && res.data.success) {
          resolve(res.data);
        } else if (res.statusCode === 409) {
          reject(new Error(res.data.error || '有正在处理中的任务'));
        } else {
          reject(new Error(res.data.error || '提交失败'));
        }
      },
      fail(err) {
        reject(new Error('网络请求失败'));
      },
    });
  });
}

/**
 * 查询任务结果
 * @param {string} openid - 微信用户 openid
 * @param {string} bizCode - 业务代码
 * @returns {Promise<object>}
 */
export function queryTaskResult(openid, bizCode) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${BASE_URL}/api/photo/result`,
      method: 'GET',
      data: {
        openid: openid,
        bizCode: bizCode,
      },
      success(res) {
        if (res.statusCode === 200 && res.data.success) {
          resolve(res.data.data);
        } else {
          reject(new Error(res.data.error || '查询失败'));
        }
      },
      fail(err) {
        reject(new Error('网络请求失败'));
      },
    });
  });
}
```

### 页面调用示例

```javascript
// pages/photo-restore/index.js
import { wechatLogin, uploadFile, submitPhotoRestore, queryTaskResult } from '../../utils/api';

Page({
  data: {
    status: 'idle',      // idle | uploading | pending | running | success | failed
    resultImageUrl: '',
    errorMessage: '',
    openid: '',
  },

  // 页面加载时自动登录
  async onLoad() {
    try {
      const loginResult = await wechatLogin();
      this.setData({ openid: loginResult.openid });
      console.log('登录成功，openid:', loginResult.openid);
      // 也可以存入 globalData
      getApp().globalData.openid = loginResult.openid;
    } catch (err) {
      console.error('登录失败:', err.message);
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
  },

  // 用户选择照片并提交修复
  async onChoosePhoto() {
    try {
      // 1. 选择图片
      const chooseResult = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
      });

      const tempFilePath = chooseResult.tempFiles[0].tempFilePath;
      this.setData({ status: 'uploading' });

      // 2. 上传照片到服务器（无需自建 OSS！）
      const uploadResult = await uploadFile(tempFilePath);
      const imageUrl = uploadResult.downloadUrl;
      console.log('文件上传成功，公网URL:', imageUrl);

      // 3. 获取用户 openid（从登录信息中获取）
      const openid = this.data.openid || getApp().globalData.openid;
      if (!openid) {
        throw new Error('未登录，请重新打开小程序');
      }

      // 4. 提交修复任务（使用上传返回的 downloadUrl 作为 imageUrl）
      this.setData({ status: 'pending' });
      const result = await submitPhotoRestore(openid, imageUrl);
      console.log('任务已提交:', result);

      wx.showToast({
        title: '已提交，后台处理中',
        icon: 'success',
      });

      // 5. 开始轮询查询结果
      this.startPolling(openid, 'photo_restore');
    } catch (err) {
      this.setData({
        status: 'failed',
        errorMessage: err.message,
      });
      wx.showToast({
        title: err.message,
        icon: 'none',
      });
    }
  },

  // 轮询查询结果
  startPolling(openid, bizCode) {
    let count = 0;
    const maxCount = 60; // 最多轮询 60 次
    const interval = 5000; // 每 5 秒查询一次

    const poll = async () => {
      if (count >= maxCount) {
        this.setData({
          status: 'failed',
          errorMessage: '处理超时，请稍后手动查询',
        });
        return;
      }

      count++;
      try {
        const result = await queryTaskResult(openid, bizCode);

        switch (result.status) {
          case 'SUCCESS':
            this.setData({
              status: 'success',
              resultImageUrl: result.outputImageUrl,
            });
            wx.showToast({ title: '修复完成！', icon: 'success' });
            return; // 停止轮询

          case 'FAILED':
            this.setData({
              status: 'failed',
              errorMessage: result.message,
            });
            return; // 停止轮询

          case 'PENDING':
            this.setData({ status: 'pending' });
            break;

          case 'RUNNING':
            this.setData({ status: 'running' });
            break;
        }

        // 继续轮询
        setTimeout(poll, interval);
      } catch (err) {
        console.error('查询失败:', err);
        setTimeout(poll, interval); // 失败也继续重试
      }
    };

    // 首次查询延迟 5 秒
    setTimeout(poll, interval);
  },
});
```

### WXML 页面模板示例

```html
<!-- pages/photo-restore/index.wxml -->
<view class="container">
  <view class="title">老照片修复</view>

  <!-- 选择照片按钮 -->
  <button
    wx:if="{{status === 'idle' || status === 'success' || status === 'failed'}}"
    bindtap="onChoosePhoto"
    type="primary"
  >
    选择照片开始修复
  </button>

  <!-- 处理中状态 -->
  <view wx:if="{{status === 'uploading'}}" class="loading">
    <text>正在上传照片...</text>
  </view>

  <view wx:if="{{status === 'pending'}}" class="loading">
    <text>任务已提交，正在排队中...</text>
  </view>

  <view wx:if="{{status === 'running'}}" class="loading">
    <text>照片修复处理中，请稍候...</text>
  </view>

  <!-- 成功结果 -->
  <view wx:if="{{status === 'success'}}" class="result">
    <text>修复完成！</text>
    <image
      src="{{resultImageUrl}}"
      mode="widthFix"
      show-menu-by-longpress="{{true}}"
    />
  </view>

  <!-- 失败状态 -->
  <view wx:if="{{status === 'failed'}}" class="error">
    <text>{{errorMessage}}</text>
    <button bindtap="onChoosePhoto" size="mini">重新提交</button>
  </view>
</view>
```

### 真人转动漫页面调用示例

```javascript
// pages/anime-convert/index.js
import { wechatLogin, uploadFile, submitAnimeConvert, queryTaskResult } from '../../utils/api';

Page({
  data: {
    status: 'idle',      // idle | uploading | pending | running | success | failed
    resultImageUrl: '',
    originalImageUrl: '',
    errorMessage: '',
    openid: '',
  },

  // 页面加载时自动登录
  async onLoad() {
    try {
      const loginResult = await wechatLogin();
      this.setData({ openid: loginResult.openid });
      console.log('登录成功，openid:', loginResult.openid);
      getApp().globalData.openid = loginResult.openid;
    } catch (err) {
      console.error('登录失败:', err.message);
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
  },

  // 用户选择照片并提交动漫转换
  async onChoosePhoto() {
    try {
      // 1. 选择图片
      const chooseResult = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
      });

      const tempFilePath = chooseResult.tempFiles[0].tempFilePath;
      this.setData({ status: 'uploading', originalImageUrl: tempFilePath });

      // 2. 上传照片到服务器
      const uploadResult = await uploadFile(tempFilePath);
      const imageUrl = uploadResult.downloadUrl;
      console.log('文件上传成功，公网URL:', imageUrl);

      // 3. 获取用户 openid
      const openid = this.data.openid || getApp().globalData.openid;
      if (!openid) {
        throw new Error('未登录，请重新打开小程序');
      }

      // 4. 提交动漫转换任务
      this.setData({ status: 'pending' });
      const result = await submitAnimeConvert(openid, imageUrl);
      console.log('任务已提交:', result);

      wx.showToast({
        title: '已提交，后台处理中',
        icon: 'success',
      });

      // 5. 开始轮询查询结果
      this.startPolling(openid, 'anime_convert');
    } catch (err) {
      this.setData({
        status: 'failed',
        errorMessage: err.message,
      });
      wx.showToast({
        title: err.message,
        icon: 'none',
      });
    }
  },

  // 轮询查询结果
  startPolling(openid, bizCode) {
    let count = 0;
    const maxCount = 60;
    const interval = 5000;

    const poll = async () => {
      if (count >= maxCount) {
        this.setData({
          status: 'failed',
          errorMessage: '处理超时，请稍后手动查询',
        });
        return;
      }

      count++;
      try {
        const result = await queryTaskResult(openid, bizCode);

        switch (result.status) {
          case 'SUCCESS':
            this.setData({
              status: 'success',
              resultImageUrl: result.outputImageUrl,
            });
            wx.showToast({ title: '转换完成！', icon: 'success' });
            return;

          case 'FAILED':
            this.setData({
              status: 'failed',
              errorMessage: result.message,
            });
            return;

          case 'PENDING':
            this.setData({ status: 'pending' });
            break;

          case 'RUNNING':
            this.setData({ status: 'running' });
            break;
        }

        setTimeout(poll, interval);
      } catch (err) {
        console.error('查询失败:', err);
        setTimeout(poll, interval);
      }
    };

    setTimeout(poll, interval);
  },
});
```

### 真人转动漫 WXML 页面模板示例

```html
<!-- pages/anime-convert/index.wxml -->
<view class="container">
  <view class="title">真人转动漫</view>

  <!-- 选择照片按钮 -->
  <button
    wx:if="{{status === 'idle' || status === 'success' || status === 'failed'}}"
    bindtap="onChoosePhoto"
    type="primary"
  >
    选择照片开始转换
  </button>

  <!-- 处理中状态 -->
  <view wx:if="{{status === 'uploading'}}" class="loading">
    <text>正在上传照片...</text>
  </view>

  <view wx:if="{{status === 'pending'}}" class="loading">
    <text>任务已提交，正在排队中...</text>
  </view>

  <view wx:if="{{status === 'running'}}" class="loading">
    <text>动漫转换处理中，请稍候...</text>
  </view>

  <!-- 成功结果 -->
  <view wx:if="{{status === 'success'}}" class="result">
    <text>转换完成！</text>
    <view class="compare">
      <view class="compare-item">
        <text>原图</text>
        <image src="{{originalImageUrl}}" mode="widthFix" />
      </view>
      <view class="compare-item">
        <text>动漫风</text>
        <image
          src="{{resultImageUrl}}"
          mode="widthFix"
          show-menu-by-longpress="{{true}}"
        />
      </view>
    </view>
  </view>

  <!-- 失败状态 -->
  <view wx:if="{{status === 'failed'}}" class="error">
    <text>{{errorMessage}}</text>
    <button bindtap="onChoosePhoto" size="mini">重新提交</button>
  </view>
</view>
```

---

## 常见问题

### Q: 照片 URL 怎么获取？
A: 使用 `POST /api/upload` 接口上传照片文件，接口会返回 `downloadUrl`（公网可访问的 URL），将该 URL 作为 `imageUrl` 参数传给老照片修复接口即可。**无需自建 OSS/COS 等云存储服务。**

### Q: 修复需要多长时间？
A: 通常 30 秒到 2 分钟不等，取决于图片大小和 RunningHub 的排队情况。建议设置最长 5 分钟的超时。

### Q: 并发限制是什么意思？
A: 同一用户（同一个 openid）的同一种业务（同一个 bizCode）同一时间只能有一个正在处理的任务。必须等上一个任务完成或失败后才能提交新的。不同业务之间互不影响。

### Q: 超过 30 分钟任务还在 PENDING 状态？
A: 系统会自动将超过 30 分钟未完成的任务标记为 FAILED，释放并发锁定。用户可以重新提交。

### Q: 修复后的图片 URL 有效期多久？
A: RunningHub 生成的图片 URL 可能有时效性（通常数小时到数天）。建议：
1. 用户查看成功后，及时下载或保存到相册
2. 或者后端在收到 Webhook 时，将图片下载并存储到自己的 OSS

### Q: 如何获取 openid？
A: 调用 `POST /api/wechat/login` 接口。前端先通过 `wx.login` 获取临时登录凭证 code，然后将 code 发送给此接口，服务端会调用微信的 `jscode2session` 接口换取 openid 并返回。建议在小程序启动时（`onLaunch` 或页面 `onLoad`）就调用登录接口并缓存 openid。

### Q: 服务端需要配置哪些环境变量？
A: 需要配置以下环境变量：
- `WECHAT_APPID` — 微信小程序 AppID
- `WECHAT_SECRET` — 微信小程序 AppSecret
- `RUNNINGHUB_API_KEY` — RunningHub API 密钥
- `DATABASE_URL` — PostgreSQL 数据库连接字符串
- `RUNNINGHUB_WEBAPP_ID_ANIME_CONVERT` — （可选）真人转动漫工作流 ID，默认为 `2059878371705843713`
