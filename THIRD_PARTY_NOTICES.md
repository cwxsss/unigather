# 第三方声明

## Mass-email v0.1.1

UniGather 的点对点 SMTP 发送流程参考了 [Mass-email v0.1.1](https://github.com/cwxsss/Mass-email/releases/tag/v0.1.1) 的公开设计，包括测试发送、正式发送前确认、按收件人逐封投递、附件编码以及 HTTP/SOCKS5 代理连接思路。

本项目未打包 Mass-email 的二进制文件，也未复制其源代码；UniGather 使用 Rust 在本地重新实现了兼容的发送流程。上游项目采用 MIT License，许可证文本见 [上游 LICENSE](https://github.com/cwxsss/Mass-email/blob/v0.1.1/LICENSE)。
