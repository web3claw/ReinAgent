//! console_decode —— 控制台程序输出的「字节 → 字符串」解码（Windows 代码页兜底）。
//!
//! 背景（2026-10-06 实测）：中文版 Windows 的控制台程序（ping/ipconfig/systeminfo 等）
//! 往**管道**写输出用的是系统 OEM 代码页（zh-CN 为 936/GBK），不是 UTF-8——按 UTF-8
//! 解码时每个汉字变 U+FFFD 替换符（工具卡显示为花块，ASCII 幸存）。
//!
//! 策略：**严格 UTF-8 校验优先**（pwsh 7、git 等本就输出 UTF-8，零影响）；校验失败
//! 再按系统代码页解（`GetOEMCP` + `MultiByteToWideChar`，复用既有 windows 依赖）。
//! 非 Windows 终端恒 UTF-8，维持 lossy。ConPTY（terminal.rs PTY）输出本就是 UTF-8，
//! 走同一入口时 UTF-8-first 直通无损。

/// 有状态增量解码器：跨 read 分块拼接多字节字符，只在完整字符边界切割。
///
/// ConPTY/管道按 OS 缓冲节奏交付字节，read 的块边界可能停在一个多字节字符中间；
/// 逐块独立解码会把残缺前半截与孤立后半截各变一个 U+FFFD（劈字符）。本解码器把
/// 末尾不完整序列扣留到下一次 push 拼接；流结束时用 flush() lossy 清空残余。
pub(crate) struct Utf8StreamDecoder {
    carry: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub(crate) fn new() -> Self {
        Self { carry: Vec::new() }
    }

    /// 喂入新字节，返回本次可安全输出的完整字符文本（末尾不完整序列扣留时可能为空）。
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.carry) {
                Ok(s) => {
                    out.push_str(s);
                    self.carry.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        out.push_str(std::str::from_utf8(&self.carry[..valid]).unwrap_or_default());
                    }
                    match e.error_len() {
                        // 末尾序列不完整：扣留残缺尾巴，等下一块拼接
                        None => {
                            self.carry.drain(..valid);
                            break;
                        }
                        // 真非法字节：lossy 输出后丢弃，继续校验余下部分
                        Some(bad_len) => {
                            out.push_str(&String::from_utf8_lossy(
                                &self.carry[valid..valid + bad_len],
                            ));
                            self.carry.drain(..valid + bad_len);
                        }
                    }
                }
            }
        }
        out
    }

    /// 流结束：清空残余，残缺尾巴按 lossy 输出（截断的序列记一个 U+FFFD）。
    pub(crate) fn flush(&mut self) -> String {
        let out = String::from_utf8_lossy(&self.carry).into_owned();
        self.carry.clear();
        out
    }
}

/// 返回 bytes 中可安全解码的前缀长度（完整字符边界）：末尾悬挂的 UTF-8 不完整序列
/// 被扣留。UTF-8 截断尾巴与 GBK 双字节首字节在字节层面不可区分、处理方式一致——
/// GBK 管道输出末尾悬挂首字节时，UTF-8 严格校验同样报 error_len()==None，扣留到
/// 下一批拼接后自然落入 decode_console_bytes 的 GBK 兜底，两套编码边界互不干扰。
pub(crate) fn complete_boundary_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => match e.error_len() {
            None => e.valid_up_to(),
            // 中途真非法字节（UTF-8 边界语义失效，走 GBK 兜底路径）：
            // 仅当末字节落在 GBK 首字节区段（0x81-0xFE）时扣留 1 字节
            Some(_) => {
                let last = *bytes.last().unwrap_or(&0);
                if (0x81..=0xFE).contains(&last) {
                    bytes.len() - 1
                } else {
                    bytes.len()
                }
            }
        },
    }
}

/// 控制台输出字节 → 字符串：UTF-8 严格校验优先，失败按系统代码页兜底。
pub(crate) fn decode_console_bytes(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    #[cfg(windows)]
    {
        let codepage = unsafe { windows::Win32::Globalization::GetOEMCP() };
        return decode_with_codepage(bytes, codepage);
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// 按指定 Windows 代码页解码（MultiByteToWideChar；任何一步失败回退 lossy，绝不 panic）。
/// 单独导出供测试用（GetOEMCP 依赖机器语言区域，测试用固定 936/GBK 才可断言）。
#[cfg(windows)]
pub(crate) fn decode_with_codepage(bytes: &[u8], codepage: u32) -> String {
    use windows::Win32::Globalization::{MultiByteToWideChar, MB_PRECOMPOSED};
    if codepage == 0 || bytes.is_empty() {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    // 第一遍传 None 查所需宽字符数；第二遍真正转换
    let wide_len = unsafe { MultiByteToWideChar(codepage, MB_PRECOMPOSED, bytes, None) };
    if wide_len <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut wide = vec![0u16; wide_len as usize];
    let written = unsafe { MultiByteToWideChar(codepage, MB_PRECOMPOSED, bytes, Some(&mut wide)) };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..written as usize])
}

#[cfg(test)]
mod stream_decoder_tests {
    use super::*;

    /// 「你」= E4 BD A0、「😀」= F0 9F 98 80，从中间劈开跨两次 push 必须无损拼回。
    #[test]
    fn splits_multibyte_chars_across_pushes() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"\xe4\xbd"), "");
        assert_eq!(d.push(b"\xa0"), "你");
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(&[0xF0, 0x9F]), "");
        assert_eq!(d.push(&[0x98]), "");
        assert_eq!(d.push(&[0x80]), "😀");
    }

    #[test]
    fn ascii_and_mixed_content_pass_through() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"bytes="), "bytes=");
        assert_eq!(d.push("=32 来自".as_bytes()), "=32 来自");
    }

    #[test]
    fn invalid_bytes_lossy_without_holding() {
        let mut d = Utf8StreamDecoder::new();
        // 0xFF 是立即非法字节，0xE4 0xB8 为截断尾巴扣留，下一块拼出「中」
        assert_eq!(d.push(&[0xFF, 0xE4, 0xB8]), "\u{FFFD}");
        assert_eq!(d.push(b"\xad"), "中");
    }

    #[test]
    fn flush_emits_truncated_tail_lossy() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.push(b"\xe4\xbd"), "");
        assert_eq!(d.flush(), "\u{FFFD}");
        assert_eq!(d.flush(), "");
    }

    /// 完整边界扣留：UTF-8 截断尾巴按 valid_up_to 扣留。
    #[test]
    fn complete_boundary_len_holds_truncated_utf8() {
        let full = "你好".as_bytes();
        assert_eq!(complete_boundary_len(full), full.len());
        assert_eq!(complete_boundary_len(&full[..5]), 3);
        assert_eq!(complete_boundary_len(&full[..1]), 0);
        assert_eq!(complete_boundary_len(b"plain ascii"), 11);
    }

    /// GBK 管道输出（UTF-8 校验中途真失败）末尾悬挂首字节 0x81-0xFE 时扣留 1 字节。
    #[test]
    fn complete_boundary_len_holds_gbk_lead_byte() {
        // 来自 = C0 B4 D7 D4（GBK）；末尾悬挂一个首字节
        let gbk: &[u8] = &[0xC0, 0xB4, 0xD7, 0xD4, 0xC4];
        assert_eq!(complete_boundary_len(gbk), 4);
        // 末字节是 ASCII（GBK 单字节区段）不扣留
        assert_eq!(complete_boundary_len(&[0xC0, 0xB4, b'a']), 3);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// GBK 样本取自实测 ping 管道输出的字节（zh-CN OEM CP 936）：
    /// c0b4 d7d4=来自；b5c4 bbd8 b8b4=的回复；d7d6 bdDa=字节。
    #[test]
    fn gbk_bytes_decode_to_chinese() {
        let gbk = [
            0xc0u8, 0xb4, 0xd7, 0xd4, // 来自
        ];
        assert_eq!(decode_with_codepage(&gbk, 936), "来自");
        let line: Vec<u8> = b"\xc0\xb4\xd7\xd4 127.0.0.1 \xb5\xc4\xbb\xd8\xb8\xb4: \xd7\xd6\xbd\xda=32"
            .to_vec();
        assert_eq!(
            decode_with_codepage(&line, 936),
            "来自 127.0.0.1 的回复: 字节=32"
        );
    }

    #[test]
    fn utf8_passes_through_untouched() {
        let utf8 = "来自 UTF-8 的回复 bytes=32 ✅".as_bytes();
        assert_eq!(decode_console_bytes(utf8), "来自 UTF-8 的回复 bytes=32 ✅");
    }

    #[test]
    fn invalid_bytes_fall_back_lossy_without_panic() {
        // 0x80 单独出现既非合法 UTF-8，GBK 里也是不完整序列
        let out = decode_console_bytes(&[0x80, b'a', 0xff]);
        assert!(!out.is_empty(), "任何输入都不应返回空或 panic");
    }
}
