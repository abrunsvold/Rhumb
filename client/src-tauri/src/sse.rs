/// Incremental Server-Sent-Events parser. Feed it chunks; it returns the JSON
/// payload of each `data:` frame completed by that chunk. Frames end on a blank line.
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn new() -> Self {
        SseParser { buf: String::new() }
    }

    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        // Frames are separated by a blank line ("\n\n").
        while let Some(idx) = self.buf.find("\n\n") {
            let frame: String = self.buf[..idx].to_string();
            self.buf = self.buf[idx + 2..].to_string();
            for line in frame.lines() {
                if let Some(rest) = line.strip_prefix("data: ") {
                    out.push(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("data:") {
                    out.push(rest.to_string());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_complete_frame() {
        let mut p = SseParser::new();
        assert_eq!(p.push("data: {\"a\":1}\n\n"), vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn waits_for_the_blank_line_across_chunks() {
        let mut p = SseParser::new();
        assert_eq!(p.push("data: {\"a\":1}"), Vec::<String>::new());
        assert_eq!(p.push("\n\n"), vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn parses_multiple_frames_in_one_chunk() {
        let mut p = SseParser::new();
        assert_eq!(
            p.push("data: 1\n\ndata: 2\n\n"),
            vec!["1".to_string(), "2".to_string()]
        );
    }

    #[test]
    fn ignores_non_data_lines() {
        let mut p = SseParser::new();
        assert_eq!(p.push(": comment\n\n"), Vec::<String>::new());
    }
}
