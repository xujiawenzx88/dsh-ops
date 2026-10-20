//! Text encoding detection and strict, lossless decode/encode for file tools.
//!
//! dsh-ops reads three text families: UTF-8, GB18030 and BOM-marked UTF-16.
//! Detection is deliberately strict: bytes are accepted only when a lossless
//! round trip through the chosen codec reproduces them exactly, so an accepted
//! file can always be edited and written back without changing a byte the model
//! did not ask to change. Bytes that no codec reads losslessly are binary, and
//! every text tool refuses them instead of decoding lossily.
//!
//! A BOM is *not* stripped from the text: it arrives as U+FEFF and is written
//! back as the same bytes, which keeps the round trip exact and matches how a
//! UTF-8 BOM has always been shown.
use crate::contract::{Failure, Result};
use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE};
use std::borrow::Cow;

/// The codecs the file tools read and write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Gb18030,
}

impl TextEncoding {
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf16Le => "UTF-16LE",
            Self::Utf16Be => "UTF-16BE",
            Self::Gb18030 => "GB18030",
        }
    }
}

fn codec(encoding: TextEncoding) -> &'static Encoding {
    match encoding {
        TextEncoding::Utf8 => encoding_rs::UTF_8,
        TextEncoding::Utf16Le => UTF_16LE,
        TextEncoding::Utf16Be => UTF_16BE,
        TextEncoding::Gb18030 => GB18030,
    }
}

/// Parse an `encoding` argument: `None` is `auto`. An unrecognized value is
/// refused before any file is read, naming the supported set.
pub fn parse(value: &str) -> Result<Option<TextEncoding>> {
    match value.to_ascii_lowercase().as_str() {
        "auto" => Ok(None),
        "utf-8" => Ok(Some(TextEncoding::Utf8)),
        "gb18030" => Ok(Some(TextEncoding::Gb18030)),
        "utf-16le" => Ok(Some(TextEncoding::Utf16Le)),
        "utf-16be" => Ok(Some(TextEncoding::Utf16Be)),
        _ => {
            let mut failure = Failure::new("ERR_INVALID_ENCODING", format!("Unsupported encoding value {value:?}"));
            failure.next_action = "Supported encodings: auto (default), utf-8, gb18030, utf-16le, utf-16be. Correct the value; nothing was read.".into();
            Err(failure)
        }
    }
}

/// The codec that reads `bytes` losslessly, or `None` when the bytes are binary.
///
/// Order matters: a UTF-16 BOM selects UTF-16 first (including the UTF-32LE
/// BOM, which is refused), valid UTF-8 wins next because its ASCII range
/// overlaps GB18030 and re-encoding is byte-identical either way, and GB18030
/// is the remaining fallback with a NUL-sample guard: a NUL in non-UTF-8 bytes
/// reads as a binary file, not as GB18030 text.
pub fn detect(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) { return None; }
    if bytes.starts_with(&[0xFF, 0xFE]) { return strict(UTF_16LE, bytes).then_some(TextEncoding::Utf16Le); }
    if bytes.starts_with(&[0xFE, 0xFF]) { return strict(UTF_16BE, bytes).then_some(TextEncoding::Utf16Be); }
    if std::str::from_utf8(bytes).is_ok() { return Some(TextEncoding::Utf8); }
    if bytes[..bytes.len().min(1024)].contains(&0) { return None; }
    let decoded = GB18030.decode_without_bom_handling_and_without_replacement(bytes)?;
    let (encoded, _, had_errors) = GB18030.encode(&decoded);
    (!had_errors && encoded.as_ref() == bytes).then_some(TextEncoding::Gb18030)
}

/// Whether `bytes` is well-formed text in `encoding` (unpaired UTF-16
/// surrogates and truncated sequences are refused).
fn strict(encoding: &'static Encoding, bytes: &[u8]) -> bool {
    encoding.decode_without_bom_handling_and_without_replacement(bytes).is_some()
}

fn binary() -> Failure {
    Failure::new("ERR_INVALID_ENCODING", "File bytes are not UTF-8, GB18030 or BOM-marked UTF-16 text")
}

fn not_valid(encoding: TextEncoding) -> Failure {
    Failure::new("ERR_INVALID_ENCODING", format!("File bytes are not valid {} text", encoding.label()))
}

/// Decode `bytes` with the requested codec (`None` = auto). Never decodes
/// lossily: the result carries no U+FFFD replacements and no numeric character
/// references, or the call fails.
pub fn decode<'a>(requested: Option<TextEncoding>, bytes: &'a [u8]) -> Result<(Cow<'a, str>, TextEncoding)> {
    let Some(encoding) = requested.or_else(|| detect(bytes)) else { return Err(binary()); };
    match encoding {
        TextEncoding::Utf8 => std::str::from_utf8(bytes)
            .map(|text| (Cow::Borrowed(text), TextEncoding::Utf8))
            .map_err(|_| not_valid(TextEncoding::Utf8)),
        _ => codec(encoding)
            .decode_without_bom_handling_and_without_replacement(bytes)
            .map(|text| (text, encoding))
            .ok_or_else(|| not_valid(encoding)),
    }
}

/// Encode `text` with `encoding`. Characters the codec cannot represent reject
/// the whole call: `encoding_rs` would otherwise emit numeric character
/// references, which silently corrupts what the model asked to write.
pub fn encode(encoding: TextEncoding, text: &str) -> Result<Vec<u8>> {
    match encoding {
        TextEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        // encoding_rs deliberately redirects the UTF-16 encodings to UTF-8 (their
        // WHATWG "output encoding"), so the code units are written here directly:
        // UTF-16 is a total, lossless mapping of every Rust string.
        TextEncoding::Utf16Le => Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect()),
        TextEncoding::Utf16Be => Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect()),
        TextEncoding::Gb18030 => {
            let (encoded, _, had_errors) = GB18030.encode(text);
            if had_errors {
                return Err(Failure::new("ERR_INVALID_ENCODING", format!("Text contains characters that {} cannot represent; nothing was written", encoding.label())));
            }
            Ok(encoded.into_owned())
        }
    }
}

/// The codec a write must use: an explicit `encoding` wins, otherwise an
/// existing file's detected codec is preserved. A new file — or bytes no codec
/// reads — is UTF-8, which is how write_file has always created files.
pub fn for_rewrite(original: Option<&[u8]>, requested: Option<TextEncoding>) -> TextEncoding {
    requested.or_else(|| original.and_then(detect)).unwrap_or(TextEncoding::Utf8)
}

/// Encode replacement content with the codec the write must use, re-attaching
/// the BOM the original carried when the content does not bring its own. Without
/// this, overwriting a BOM-marked UTF-16 file with plain content would drop the
/// only marker that identifies its encoding, and the next read would see binary.
///
/// An explicit UTF-16 `encoding` also adds a BOM: a new UTF-16LE file whose
/// ASCII range is valid UTF-8 bytes could not be detected without one.
pub fn encode_for_rewrite(original: Option<&[u8]>, content: &str, requested: Option<TextEncoding>) -> Result<Vec<u8>> {
    let encoding = for_rewrite(original, requested);
    let bom = match encoding {
        TextEncoding::Utf16Le if requested.is_some() || original.is_some_and(|bytes| bytes.starts_with(&[0xFF, 0xFE])) => Some(&[0xFF, 0xFE][..]),
        TextEncoding::Utf16Be if requested.is_some() || original.is_some_and(|bytes| bytes.starts_with(&[0xFE, 0xFF])) => Some(&[0xFE, 0xFF][..]),
        _ => None,
    };
    let mut bytes = match bom {
        Some(bom) if !content.starts_with('\u{FEFF}') => bom.to_vec(),
        _ => Vec::new(),
    };
    bytes.extend(encode(encoding, content)?);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str, little_endian: bool) -> Vec<u8> {
        let mut bytes = if little_endian { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for unit in text.encode_utf16() { bytes.extend(if little_endian { unit.to_le_bytes() } else { unit.to_be_bytes() }); }
        bytes
    }

    #[test]
    fn bom_selects_utf16_and_the_bom_stays_in_the_text() {
        for (little_endian, expected) in [(true, TextEncoding::Utf16Le), (false, TextEncoding::Utf16Be)] {
            let bytes = utf16("α😀", little_endian);
            let (text, encoding) = decode(None, &bytes).unwrap();
            assert_eq!(encoding, expected);
            assert_eq!(text, "\u{FEFF}α😀");
            assert_eq!(encode(encoding, &text).unwrap(), bytes, "round trip is byte-identical");
        }
    }

    #[test]
    fn utf16_without_a_bom_keeps_reading_as_utf8() {
        // No BOM: ASCII UTF-16LE bytes are valid UTF-8 (NULs and all), so the
        // file keeps reading as UTF-8 — the behavior before this feature.
        let bytes: Vec<u8> = "ab".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(detect(&bytes), Some(TextEncoding::Utf8));
    }

    #[test]
    fn malformed_utf16_is_refused() {
        assert_eq!(detect(&[0xFF, 0xFE, 0x61]), None, "odd byte count");
        assert_eq!(detect(&[0xFF, 0xFE, 0x00, 0xD8]), None, "unpaired surrogate");
        assert!(decode(Some(TextEncoding::Utf16Le), &[0xFF, 0xFE, 0x61]).is_err());
    }

    #[test]
    fn utf32le_bom_is_binary() {
        assert_eq!(detect(&[0xFF, 0xFE, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]), None);
    }

    #[test]
    fn gb18030_is_detected_and_round_trips() {
        let bytes = b"a\xD6\xD0\xCE\xC4b"; // a中文b
        let (text, encoding) = decode(None, bytes).unwrap();
        assert_eq!(encoding, TextEncoding::Gb18030);
        assert_eq!(text, "a中文b");
        assert_eq!(encode(encoding, &text).unwrap(), bytes);
    }

    #[test]
    fn gb18030_four_byte_forms_round_trip() {
        let bytes = vec![0x81, 0x30, 0x81, 0x30]; // U+0080, the first four-byte form
        let (text, encoding) = decode(None, &bytes).unwrap();
        assert_eq!(encoding, TextEncoding::Gb18030);
        assert_eq!(text, "\u{80}");
        assert_eq!(encode(encoding, &text).unwrap(), bytes);
    }

    #[test]
    fn nul_bytes_are_binary_only_on_the_gb18030_fallback() {
        let bytes = b"\xD6\xD0\x00";
        assert!(GB18030.decode_without_bom_handling_and_without_replacement(bytes).is_some(), "GB18030 alone would decode this");
        assert_eq!(detect(bytes), None, "the NUL sample guard keeps it binary");
        assert_eq!(detect(b"a\x00b"), Some(TextEncoding::Utf8), "UTF-8 with a NUL is unchanged behavior");
    }

    #[test]
    fn explicit_encoding_is_strict() {
        assert!(decode(Some(TextEncoding::Gb18030), &[0xFF]).is_err());
        assert!(decode(Some(TextEncoding::Utf8), b"\xD6\xD0").is_err());
    }

    #[test]
    fn gb18030_refuses_what_it_cannot_represent() {
        // WHATWG gb18030 has no encoding for U+E5E5; a numeric character
        // reference would corrupt the file, so the call is refused.
        assert!(encode(TextEncoding::Gb18030, "\u{E5E5}").is_err());
        assert!(encode(TextEncoding::Gb18030, "中文😀").is_ok(), "gb18030 covers all other scalar values");
    }

    #[test]
    fn parse_accepts_the_supported_set_only() {
        assert_eq!(parse("auto").unwrap(), None);
        assert_eq!(parse("UTF-8").unwrap(), Some(TextEncoding::Utf8));
        assert_eq!(parse("GB18030").unwrap(), Some(TextEncoding::Gb18030));
        for value in ["gbk", "utf-16", "utf-32", ""] {
            let failure = parse(value).unwrap_err();
            assert_eq!(failure.code, "ERR_INVALID_ENCODING");
            assert!(failure.next_action.contains("gb18030"), "{value}");
        }
    }

    #[test]
    fn for_rewrite_keeps_detected_bytes_and_defaults_to_utf8() {
        assert_eq!(for_rewrite(Some(b"\xD6\xD0"), None), TextEncoding::Gb18030);
        assert_eq!(for_rewrite(Some(b"plain"), None), TextEncoding::Utf8);
        assert_eq!(for_rewrite(Some(&[0xFF, 0x00]), None), TextEncoding::Utf8);
        assert_eq!(for_rewrite(None, None), TextEncoding::Utf8);
        assert_eq!(for_rewrite(Some(b"plain"), Some(TextEncoding::Utf16Le)), TextEncoding::Utf16Le, "an explicit codec wins");
    }

    #[test]
    fn rewriting_a_bom_marked_file_keeps_the_bom() {
        let original = utf16("α", true);
        let mut expected = vec![0xFF, 0xFE];
        expected.extend(encode(TextEncoding::Utf16Le, "β").unwrap());
        assert_eq!(encode_for_rewrite(Some(&original), "β", None).unwrap(), expected);
        // Content that brings its own U+FEFF is not doubled.
        assert_eq!(encode_for_rewrite(Some(&original), "\u{FEFF}β", None).unwrap(), expected);
        // A new file, or UTF-8 bytes, stay UTF-8 without any BOM.
        assert_eq!(encode_for_rewrite(None, "β", None).unwrap(), b"\xCE\xB2".to_vec());
        assert_eq!(encode_for_rewrite(Some(b"plain"), "β", None).unwrap(), b"\xCE\xB2".to_vec());
    }

    #[test]
    fn explicit_encoding_selects_the_published_codec() {
        // A new file follows the requested codec instead of defaulting to UTF-8.
        assert_eq!(encode_for_rewrite(None, "中", Some(TextEncoding::Gb18030)).unwrap(), b"\xD6\xD0".to_vec());
        assert_eq!(encode_for_rewrite(None, "中", Some(TextEncoding::Utf8)).unwrap(), "中".as_bytes().to_vec());
        // UTF-16 is undetectable without a BOM, so an explicit request adds one.
        let mut le = vec![0xFF, 0xFE];
        le.extend(encode(TextEncoding::Utf16Le, "中").unwrap());
        assert_eq!(encode_for_rewrite(None, "中", Some(TextEncoding::Utf16Le)).unwrap(), le);
        // Content that already starts with U+FEFF keeps its own BOM exactly once.
        assert_eq!(encode_for_rewrite(None, "\u{FEFF}中", Some(TextEncoding::Utf16Le)).unwrap(), le);
        // An explicit codec overrides an existing file's codec in both directions.
        assert_eq!(encode_for_rewrite(Some(b"plain"), "中", Some(TextEncoding::Gb18030)).unwrap(), b"\xD6\xD0".to_vec());
        let utf16_le = utf16("α", true);
        assert_eq!(encode_for_rewrite(Some(&utf16_le), "β", Some(TextEncoding::Utf8)).unwrap(), b"\xCE\xB2".to_vec());
        assert_eq!(encode_for_rewrite(Some(b"plain"), "β", Some(TextEncoding::Utf16Be)).unwrap(), {
            let mut bytes = vec![0xFE, 0xFF];
            bytes.extend(encode(TextEncoding::Utf16Be, "β").unwrap());
            bytes
        });
    }

    #[test]
    fn an_explicit_codec_refuses_unrepresentable_characters_for_new_files() {
        assert!(encode_for_rewrite(None, "\u{E5E5}", Some(TextEncoding::Gb18030)).is_err());
    }
}
