# 第三方素材与参考说明

## 木鱼敲击音效

- **作品**：Mokugyo.wav（Freesound ID：607215）
- **作者**：jonopodmore
- **原页面**：https://freesound.org/people/jonopodmore/sounds/607215/
- **作者页面**：https://freesound.org/people/jonopodmore/
- **许可证**：Creative Commons CC0 1.0 Universal
- **许可证全文**：https://creativecommons.org/publicdomain/zero/1.0/
- **镜像页面**：https://creazilla.com/media/audio/15490963/mokugyo
- **FLAC 下载地址**：https://cdn.creazilla.com/sounds/15490963/mokugyo-sound.flac
- **获取日期**：2026-11-06

作者对原始录音的描述：来自日本高野山的小型木鱼（Mokugyo temple block），使用原装布面包头槌演奏。原页面明确标注为 Creative Commons 0，允许复制、修改、分发和演奏，包括商业用途。

本工程在 `third_party/mokugyo/` 保留获取的 FLAC 原文件；其 SHA-256 为：

```text
01ff9ddbc82b60eb24bee6b3d3dd3bdac87abeb4f6ac7cece9e8e0f923ef1b13
```

### 本项目所做的修改

`public/media/knock.wav` 由上述 FLAC 通过 `scripts/prepare-audio.py` 生成：截取前 0.42 秒，应用 45 Hz 高通滤波、+4 dB 增益与峰值限幅（alimiter 0.95）和后 110ms 淡出，转为 44.1kHz、16-bit、单声道 PCM WAV。没有混入其他录音。

CC0 不强制署名，本项目仍主动保留作者、来源及修改记录，且不暗示作者或 Freesound/Creazilla 为本小程序背书。相同署名也放在 `public/media/NOTICE.txt`，随运行 ZIP 分发。

## 实现参考（仅阅读）

以下项目用于了解木鱼应用的音效播放、连点处理和设置交互。本项目没有复制它们的音频或图片，也没有直接复制其实现代码：

- https://github.com/kid-908/Electronic-Wooden-Fish — 多实例播放及高频连点处理思路，MIT。
- https://github.com/Ares-Chang/wooden-fish — 音效切换与播放组织方式，MIT。

Discourse SDK 接入方式依据目录内官方开发包及示例，不引入其他电子木鱼项目依赖。
