# dsh-read-aloud-ad

Read finished DeepSeek Harness replies aloud in **Mandarin Xiaoxiao** (`zh-CN-XiaoxiaoNeural`), with an adjustable playback speed. Package name: `dsh-read-aloud-ad`; plugin row id: `read-aloud-ad`.

## Install

```sh
dsh plugin add dsh-read-aloud-ad
```

Or install the release tarball: download `dsh-read-aloud-ad-0.1.0.tgz` from the [latest release](https://github.com/zmq6931/dsh-read-aloud-ad/releases/latest) and run `dsh plugin add ./dsh-read-aloud-ad-0.1.0.tgz`.

Then enable **Read replies aloud** in **Plugins**.

## What it adds

A play button and a speed control in the action row of every finished reply — the row that already holds copy, like, dislike, and share. The controls sit between copy and branch.

| Control | Behavior |
|---|---|
| Play / pause | Synthesizes the reply and plays it. Click again to pause; click once more to resume. While the first chunk is being synthesized the button shows a spinner and cancels on click. |
| Speed | Opens a small menu with every 0.25× step from 0.75× up to 3× (0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3). The choice is remembered per browser and applies immediately, even mid-sentence. |

Only one reply speaks at a time: starting another stops the previous one. Long replies are split into sentence-sized chunks, so audio starts after the first chunk while the next one is fetched.

## How the audio is produced

Microsoft Edge's read-aloud service voices the text. The browser posts the reply text to this plugin's own loopback route (`/read-aloud/synthesize`), and the Host half authenticates to the service and returns MP3 bytes. No API key is configured, and no model request is added.

- The text leaves the machine only to reach that Microsoft speech service.
- Nothing is written to the session log; the plugin adds no session events.
- Synthesized MP3s are cached in Host memory for replay; the cache is not written to disk.
- The service endpoint is the consumer read-aloud endpoint Edge itself uses. It is not a versioned Microsoft API, so a change on Microsoft's side can make synthesis fail; the row then shows a short failure message and the next click retries.

## Configuration (optional)

Create `$DSH_HOME/read-aloud.json`:

```json
{
  "voice": "zh-CN-XiaoxiaoNeural",
  "maxChars": 8000
}
```

`voice` accepts any `xx-XX-…Neural` Edge voice name (for example `zh-CN-YunxiNeural`), and `maxChars` bounds one synthesis request (200–40000). Restart the Host after editing the file.

## Requirements

- Internet access to `speech.platform.bing.com`.
- The plugin's Host half must be mounted (the bundle patch adds it); without it the browser controls report a synthesis failure.

## Turning it off

Disable the bundle in **Plugins**. The buttons and the `/read-aloud` route disappear; nothing else changes.

## 中文说明

安装:`dsh plugin add dsh-read-aloud-ad`(或下载 release 里的 `dsh-read-aloud-ad-0.1.0.tgz`,执行 `dsh plugin add ./dsh-read-aloud-ad-0.1.0.tgz`),然后在 **Plugins** 里启用「朗读回复」。

在每条已结束回复的操作栏（复制、点赞、点踩那一行）里加入朗读按钮和语速按钮，使用普通话晓晓朗读。

- 点击播放按钮开始朗读，再点一次暂停，再点一次继续；合成第一段时按钮显示转圈，点击可取消。
- 点语速按钮选择 0.75 倍到 3 倍之间的每一档（0.75、1、1.25、1.5、1.75、2、2.25、2.5、2.75、3，步进 0.25），选择会记住，播放中修改立即生效。
- 同一时间只朗读一条回复；长回复会按句子分段，第一段合成完就开始播放，后面边播边取。
- 文字只发给本机插件路由，再由它调用微软 Edge 的朗读服务；不需要 API Key，不新增模型请求，也不写入会话记录。
- 语音合成结果只缓存在内存中，重启后需要重新合成。
- 如果微软调整了朗读服务，合成可能失败并显示提示，再点一次会重试。

包名：`dsh-read-aloud-ad`；插件行 id：`read-aloud-ad`；目录：`C:\Andy\deepseek_HARNESS\dsh-read-aloud-ad`。

License: MIT.
