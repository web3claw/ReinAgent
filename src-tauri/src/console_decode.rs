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
