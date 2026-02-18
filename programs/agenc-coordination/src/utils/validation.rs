//! Input validation utilities for AgenC Coordination Protocol

/// Validates that a string contains only valid UTF-8 printable characters.
///
/// This provides defense-in-depth validation for string inputs. While Rust's
/// String type guarantees UTF-8, this function additionally ensures strings
/// contain only printable ASCII characters (including space), which are safe
/// for URLs, endpoints, and metadata URIs.
///
/// # Arguments
/// * `s` - The string to validate
///
/// # Returns
/// * `true` if the string contains only ASCII graphic characters or spaces
/// * `false` if the string contains control characters or non-ASCII bytes
///
/// # Examples
/// ```
/// use agenc_coordination::utils::validation::validate_string_input;
///
/// assert!(validate_string_input("https://example.com/api"));
/// assert!(validate_string_input("hello world"));
/// assert!(!validate_string_input("hello\x00world")); // null byte
/// assert!(!validate_string_input("hello\nworld"));   // newline
/// ```
pub fn validate_string_input(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_graphic() || c == ' ')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_url() {
        assert!(validate_string_input("https://example.com/api/v1"));
        assert!(validate_string_input("http://localhost:8080"));
        assert!(validate_string_input(
            "https://api.example.com/agents?id=123"
        ));
    }

    #[test]
    fn test_valid_with_spaces() {
        assert!(validate_string_input("hello world"));
        assert!(validate_string_input("agent name with spaces"));
    }

    #[test]
    fn test_valid_special_chars() {
        assert!(validate_string_input(
            "https://example.com/path?key=value&other=123"
        ));
        assert!(validate_string_input("ipfs://QmHash123"));
        assert!(validate_string_input("ar://arweave-hash"));
    }

    #[test]
    fn test_empty_string() {
        assert!(validate_string_input(""));
    }

    #[test]
    fn test_invalid_control_chars() {
        assert!(!validate_string_input("hello\x00world")); // null byte
        assert!(!validate_string_input("hello\nworld")); // newline
        assert!(!validate_string_input("hello\rworld")); // carriage return
        assert!(!validate_string_input("hello\tworld")); // tab
        assert!(!validate_string_input("\x1b[31mred\x1b[0m")); // ANSI escape
    }

    #[test]
    fn test_invalid_non_ascii() {
        assert!(!validate_string_input("héllo")); // accented char
        assert!(!validate_string_input("hello 世界")); // Chinese chars
        assert!(!validate_string_input("emoji 🚀")); // emoji
        assert!(!validate_string_input("café")); // non-ASCII
    }

    #[test]
    fn test_all_ascii_graphic() {
        // Test all printable ASCII characters (0x21-0x7E)
        let all_printable: String = (0x21u8..=0x7Eu8).map(|b| b as char).collect();
        assert!(validate_string_input(&all_printable));
    }
}
