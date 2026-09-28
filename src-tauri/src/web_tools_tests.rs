//! web_tools 纯函数单测：实体解码 / DDG 解析 / 域名过滤 / URL 规范化与 SSRF 防护。
//! 运行：cargo test --lib web_tools

use crate::web_tools::{
    decode_entities, filter_domains, host_matches, html_to_text, is_blocked_host,
    normalize_fetch_url, parse_ddg_results, strip_tags, WebSearchHit,
};

fn hit(title: &str, url: &str, snippet: &str) -> WebSearchHit {
    WebSearchHit {
        title: title.into(),
        url: url.into(),
        snippet: snippet.into(),
    }
}

#[test]
fn decode_entities_basic_and_numeric() {
    assert_eq!(decode_entities("a &amp; b &lt;x&gt; &quot;q&quot; &#x27;"), "a & b <x> \"q\" '");
    assert_eq!(decode_entities("&#65;&#66;"), "AB");
    assert_eq!(decode_entity_nbsp(), "a b");
    // 非法实体原样保留
    assert_eq!(decode_entities("100% &amp &unknown;"), "100% &amp &unknown;");
}

fn decode_entity_nbsp() -> String {
    decode_entities("a&nbsp;b")
}

#[test]
fn strip_tags_collapses_whitespace() {
    assert_eq!(strip_tags("<b>Hello</b>   <i>world</i>\n  next"), "Hello world next");
}

#[test]
fn html_to_text_strips_and_keeps_structure() {
    let html = "<html><head><style>.x{}</style><script>var a=1;</script></head><body><h1>Title</h1><p>para <a href=\"https://e.com\">link</a></p><ul><li>one</li><li>two</li></ul></body></html>";
    let text = html_to_text(html);
    assert!(text.contains("Title"), "标题保留: {text}");
    assert!(text.contains("link"), "链接文本保留: {text}");
    assert!(text.contains("one"), "列表项保留: {text}");
    assert!(!text.contains("var a=1"), "脚本剥除: {text}");
    assert!(!text.contains(".x{}"), "样式剥除: {text}");
}

#[test]
fn parse_ddg_results_extract_organic_skip_ads() {
    let html = r#"
    <div class="result results_links results_links_deep web-result">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Page</b></a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">A &amp; B &lt;test&gt; snippet</a>
    </div>
    <div class="result result--ad">
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/y.js?ad_domain=ads.example">Sponsored</a></h2>
    </div>
    <div class="result">
      <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dudemy.com%26ad_provider%3Dbing">Udemy Ad (wrapped)</a></h2>
    </div>
    <div class="result">
      <h2 class="result__title"><a class="result__a" href="https://direct.example.org/">Direct Link</a></h2>
      <a class="result__snippet">plain snippet here</a>
    </div>
    "#;
    let hits = parse_ddg_results(html);
    assert_eq!(hits.len(), 2, "广告（含 uddg 包装）应被剔除: {hits:?}");
    assert_eq!(hits[0].url, "https://example.com/page");
    assert_eq!(hits[0].title, "Example Page");
    assert_eq!(hits[0].snippet, "A & B <test> snippet");
    assert_eq!(hits[1].url, "https://direct.example.org/");
    assert_eq!(hits[1].snippet, "plain snippet here");
}

#[test]
fn host_matches_suffix_semantics() {
    assert!(host_matches("docs.example.com", "example.com"));
    assert!(host_matches("example.com", "example.com"));
    assert!(!host_matches("notexample.com", "example.com"));
    assert!(host_matches("https://WWW.Example.com/path", "example.com"));
    assert!(host_matches("a.example.com", "https://example.com/"));
}

#[test]
fn filter_domains_allowed_blocked_and_conflict() {
    let hits = vec![
        hit("a", "https://docs.rust-lang.org/x", ""),
        hit("b", "https://spam.example.net/y", ""),
    ];
    let allowed = vec!["rust-lang.org".to_string()];
    let got = filter_domains(hits.clone(), &allowed, &[]).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].url, "https://docs.rust-lang.org/x");

    let blocked = vec!["example.net".to_string()];
    let got = filter_domains(hits.clone(), &[], &blocked).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].url, "https://docs.rust-lang.org/x");

    assert!(filter_domains(hits, &allowed, &blocked).is_err(), "两者同给必须报错");
}

#[test]
fn normalize_fetch_url_upgrades_and_rejects() {
    let (url, host) = normalize_fetch_url("http://example.com/a").unwrap();
    assert_eq!(url, "https://example.com/a");
    assert_eq!(host, "example.com");

    let (url, _) = normalize_fetch_url("  example.com/path ").unwrap();
    assert_eq!(url, "https://example.com/path");

    assert!(normalize_fetch_url("ftp://example.com").is_err(), "非 http(s) 拒绝");
    assert!(normalize_fetch_url("https://u:p@example.com").is_err(), "凭证拒绝");
    assert!(normalize_fetch_url("https://127.0.0.1/x").is_err(), "环回拒绝");
    assert!(normalize_fetch_url("https://127.0.0.1:9333/x").is_err(), "带端口环回拒绝（host 提取勿取到端口）");
    assert!(normalize_fetch_url("https://[::1]:8080/").is_err(), "IPv6 环回拒绝");
    assert!(normalize_fetch_url("https://192.168.1.4:9000/x").is_err(), "带端口私网拒绝");
    assert!(normalize_fetch_url("https://localhost/x").is_err(), "localhost 拒绝");
    // 正向：带端口合法域名 → host 正确提取
    let (url, host) = normalize_fetch_url("https://example.com:8443/x").unwrap();
    assert_eq!(url, "https://example.com:8443/x");
    assert_eq!(host, "example.com");
    assert!(normalize_fetch_url("https://172.16.0.9/x").is_err(), "172.16/12 拒绝");
    assert!(normalize_fetch_url("").is_err(), "空串拒绝");
}

#[test]
fn blocked_host_reserved_ranges() {
    assert!(is_blocked_host("127.0.0.1"));
    assert!(is_blocked_host("10.0.0.2"));
    assert!(is_blocked_host("169.254.1.1"));
    assert!(is_blocked_host("198.18.0.1"));
    assert!(is_blocked_host("100.64.0.1"));
    assert!(is_blocked_host("[::1]"));
    assert!(is_blocked_host("::ffff:127.0.0.1"));
    assert!(is_blocked_host("fd00::1"));
    assert!(!is_blocked_host("example.com"));
    assert!(!is_blocked_host("8.8.8.8"));
    assert!(!is_blocked_host("172.32.0.1"), "172.32 在 /12 之外");
}
