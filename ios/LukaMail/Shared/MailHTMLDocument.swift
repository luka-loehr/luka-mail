import Foundation

/// How a message body is painted relative to the app's appearance.
enum MailHTMLAppearance: String, Equatable, Sendable {
    /// The message sets no backgrounds. It follows the system appearance, and any explicit
    /// text colors that would be unreadable on the current background are adapted.
    case adaptive
    /// The message paints its own backgrounds. Its design is kept intact and rendered on a
    /// light canvas so that its original colors stay readable in Dark Mode.
    case original
    /// The message ships its own light and dark styles (`prefers-color-scheme`), so it is
    /// trusted to adapt itself.
    case native
}

/// Static facts about a message body that decide how it is rendered.
struct MailHTMLAnalysis: Equatable, Sendable {
    var hasBackgrounds = false
    var declaresDarkModeSupport = false
    var hasRemoteImages = false

    var appearance: MailHTMLAppearance {
        if declaresDarkModeSupport { return .native }
        return hasBackgrounds ? .original : .adaptive
    }
}

/// The body content handed to the renderer.
enum MailBodySource: Hashable, Sendable {
    case html(String)
    case plainText(String)
}

/// A complete, sandboxed HTML document for one message body.
struct MailHTMLDocument: Equatable, Sendable {
    let html: String
    let analysis: MailHTMLAnalysis
    let isDark: Bool

    var appearance: MailHTMLAppearance { analysis.appearance }

    /// Whether the web view must render with a light appearance regardless of the system.
    var forcesLightAppearance: Bool { appearance == .original }

    /// Whether the body appears as a light card on a dark screen.
    var showsLightCard: Bool { isDark && appearance == .original }

    /// Name of the script message handler that receives the rendered content height.
    static let heightMessageName = "lmHeight"

    static func make(
        source: MailBodySource,
        inlineImages: [String: String] = [:],
        allowRemoteImages: Bool,
        isDark: Bool,
        horizontalPadding: Int,
        verticalPadding: Int,
        cardPadding: (horizontal: Int, vertical: Int)? = nil
    ) -> MailHTMLDocument {
        let rawBody: String
        let analysis: MailHTMLAnalysis
        switch source {
        case .html(let html):
            rawBody = inlineImages.reduce(html) { partial, item in
                partial.replacingOccurrences(of: "cid:\(item.key)", with: item.value, options: .caseInsensitive)
            }
            analysis = analyze(rawBody)
        case .plainText(let text):
            rawBody = plainTextHTML(text)
            analysis = MailHTMLAnalysis()
        }

        let body = analysis.appearance == .adaptive ? adaptTextColors(in: rawBody, isDark: isDark) : rawBody
        let palette = Palette(appearance: analysis.appearance, isDark: isDark)
        let onCard = isDark && analysis.appearance == .original
        let padding = onCard ? cardPadding ?? (horizontalPadding, verticalPadding) : (horizontalPadding, verticalPadding)
        let imagePolicy = allowRemoteImages ? "https: http: data: cid:" : "data:"
        let colorScheme = analysis.appearance == .original ? "light" : (isDark ? "dark" : "light")
        let document = """
        <!doctype html><html class="lm-\(analysis.appearance.rawValue)"><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="\(colorScheme)">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src \(imagePolicy); style-src 'unsafe-inline'; font-src data:; media-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">
        <style>
        :root { color-scheme: \(colorScheme); --lm-text: \(palette.text); --lm-secondary: \(palette.secondary); --lm-link: \(palette.link); --lm-rule: \(palette.rule); }
        html { background: \(palette.canvas); overflow-x: hidden; -webkit-text-size-adjust: 100%; }
        body { margin: 0; padding: \(padding.1)px \(padding.0)px; font: -apple-system-body; line-height: 1.45; color: var(--lm-text); overflow-wrap: break-word; word-wrap: break-word; }
        #lm-root { display: flow-root; transform-origin: 0 0; height: auto !important; min-height: 0 !important; }
        #lm-root img { max-width: 100% !important; height: auto !important; }
        #lm-root table { max-width: 100% !important; }
        #lm-root pre { white-space: pre-wrap; overflow-wrap: anywhere; }
        #lm-root a { color: var(--lm-link); overflow-wrap: anywhere; }
        #lm-root blockquote:not([style]) { margin: 0.6em 0; padding: 0 0 0 12px; border-left: 3px solid var(--lm-rule); color: var(--lm-secondary); }
        #lm-root hr:not([style]) { border: none; border-top: 1px solid var(--lm-rule); }
        .lm-plain { white-space: pre-wrap; overflow-wrap: anywhere; }
        .lm-plain blockquote { margin: 0.2em 0; padding: 0 0 0 10px; border-left: 3px solid var(--lm-rule); color: var(--lm-secondary); }
        </style></head><body><div id="lm-root">\(body)</div></body></html>
        """
        return MailHTMLDocument(html: document, analysis: analysis, isDark: isDark)
    }

    /// Renders off the main actor; large newsletters take a few milliseconds of regex work.
    static func render(
        source: MailBodySource,
        inlineImages: [String: String],
        allowRemoteImages: Bool,
        isDark: Bool,
        horizontalPadding: Int,
        verticalPadding: Int,
        cardPadding: (horizontal: Int, vertical: Int)? = nil
    ) async -> MailHTMLDocument {
        await Task.detached(priority: .userInitiated) {
            make(source: source, inlineImages: inlineImages, allowRemoteImages: allowRemoteImages, isDark: isDark,
                 horizontalPadding: horizontalPadding, verticalPadding: verticalPadding, cardPadding: cardPadding)
        }.value
    }

    /// Fits wide content to the viewport and reports the rendered height. Runs in an isolated
    /// content world, so message-authored JavaScript stays disabled.
    static let layoutScript = """
    (() => {
      let lastHeight = -1;
      let scheduled = false;
      const measure = () => {
        scheduled = false;
        const root = document.getElementById('lm-root');
        if (!root) { return; }
        root.style.transform = '';
        root.style.width = '';
        const available = root.clientWidth;
        const natural = Math.max(root.scrollWidth, available);
        if (available > 0 && natural > available + 1) {
          root.style.width = natural + 'px';
          root.style.transform = 'scale(' + (available / natural) + ')';
        }
        const style = getComputedStyle(document.body);
        const height = Math.ceil(root.getBoundingClientRect().height
          + parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0'));
        if (Math.abs(height - lastHeight) >= 1) {
          lastHeight = height;
          window.webkit.messageHandlers.\(heightMessageName).postMessage(height);
        }
      };
      const schedule = () => {
        if (scheduled) { return; }
        scheduled = true;
        requestAnimationFrame(measure);
      };
      new ResizeObserver(schedule).observe(document.documentElement);
      document.addEventListener('load', schedule, true);
      document.addEventListener('error', schedule, true);
      window.addEventListener('load', schedule);
      measure();
    })();
    """

    // MARK: - Analysis

    static func analyze(_ html: String) -> MailHTMLAnalysis {
        var analysis = MailHTMLAnalysis()
        analysis.declaresDarkModeSupport = html.range(
            of: #"prefers-color-scheme\s*:\s*dark|<meta[^>]+name\s*=\s*["']?(supported-)?color-scheme["']?[^>]*dark|(^|[;{\s])color-scheme\s*:[^;}"']*dark"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil

        analysis.hasRemoteImages = html.range(
            of: #"<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?//|url\(\s*["']?\s*(https?:)?//|\bbackground\s*=\s*["']?\s*https?:"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil

        if html.range(of: #"<[a-z][^>]*\s(bgcolor|background)\s*=\s*["']?\s*[^\s"'>]"#,
                      options: [.regularExpression, .caseInsensitive]) != nil {
            analysis.hasBackgrounds = true
            return analysis
        }
        for css in cssFragments(in: html) {
            for match in matches(of: backgroundDeclaration, in: css) {
                if paintsBackground(match.captures[1] ?? "") {
                    analysis.hasBackgrounds = true
                    return analysis
                }
            }
        }
        return analysis
    }

    private static func paintsBackground(_ rawValue: String) -> Bool {
        let value = rawValue.replacingOccurrences(of: "!important", with: "", options: .caseInsensitive)
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.isEmpty { return false }
        let neutral: Set<String> = ["transparent", "none", "inherit", "initial", "unset", "revert", "currentcolor", "0", "auto"]
        if neutral.contains(value) { return false }
        if value.contains("url(") || value.contains("gradient(") { return true }
        // Shorthand like `none repeat scroll 0 0 transparent`: look for any opaque color token.
        let tokens = value.split(whereSeparator: { $0 == " " || $0 == "," && !value.contains("(") })
        if tokens.count > 1, !value.contains("(") {
            return tokens.contains { token in
                guard let color = CSSColor(String(token)) else { return false }
                return color.alpha > 0.05
            }
        }
        if let color = CSSColor(value) { return color.alpha > 0.05 }
        // Custom properties can't be resolved statically; assume they paint.
        return value.contains("var(")
    }

    // MARK: - Dark Mode text color adaptation

    /// Rewrites explicit text colors that would be unreadable on the current background.
    /// Only used for messages without backgrounds, where the app supplies the background.
    static func adaptTextColors(in html: String, isDark: Bool) -> String {
        var result = replacing(styleAttribute, in: html) { match in
            guard let full = match.captures[0], let value = match.captures[1] ?? match.captures[2] else { return nil }
            let adapted = adaptDeclarations(value, isDark: isDark)
            guard adapted != value else { return nil }
            let quote = match.captures[1] != nil ? "\"" : "'"
            let prefix = full.prefix { $0 != "=" }
            return "\(prefix)=\(quote)\(adapted)\(quote)"
        }
        result = replacing(styleBlock, in: result) { match in
            guard let open = match.captures[1], let css = match.captures[2], let close = match.captures[3] else { return nil }
            let adapted = adaptDeclarations(css, isDark: isDark)
            return adapted == css ? nil : open + adapted + close
        }
        result = replacing(fontColorAttribute, in: result) { match in
            guard let prefix = match.captures[1],
                  let value = match.captures[2] ?? match.captures[3] ?? match.captures[4],
                  let color = CSSColor(value) else { return nil }
            guard let replacement = adaptedColor(color, isDark: isDark) else { return nil }
            // `var()` is not valid in a presentational attribute; use an inline style instead.
            return "\(prefix)style=\"color: \(replacement)\""
        }
        return result
    }

    private static func adaptDeclarations(_ css: String, isDark: Bool) -> String {
        replacing(colorDeclaration, in: css) { match in
            guard let lead = match.captures[1], let rawValue = match.captures[2] else { return nil }
            let important = match.captures[3] ?? ""
            guard let color = CSSColor(rawValue),
                  let replacement = adaptedColor(color, isDark: isDark) else { return nil }
            return "\(lead)color: \(replacement)\(important)"
        }
    }

    /// Returns a replacement CSS value when `color` lacks contrast against the app background.
    static func adaptedColor(_ color: CSSColor, isDark: Bool) -> String? {
        guard color.alpha > 0.05 else { return nil }
        if isDark {
            let background = CSSColor(red: 0.11, green: 0.11, blue: 0.118)
            guard color.contrast(with: background) < 4.5 else { return nil }
            if color.saturation < 0.25 { return "var(--lm-text)" }
            var lightness = max(1 - color.lightness, 0.72)
            var candidate = color.withLightness(lightness)
            while candidate.contrast(with: background) < 4.5, lightness < 0.95 {
                lightness += 0.04
                candidate = color.withLightness(lightness)
            }
            return candidate.hex
        } else {
            let background = CSSColor(red: 1, green: 1, blue: 1)
            guard color.contrast(with: background) < 2 else { return nil }
            if color.saturation < 0.25 { return "var(--lm-text)" }
            return color.withLightness(min(1 - color.lightness, 0.4)).hex
        }
    }

    // MARK: - Plain text

    static func plainTextHTML(_ text: String) -> String {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        return "<div class=\"lm-plain\">\(quotedLines(lines))</div>"
    }

    private static func quotedLines(_ lines: [String]) -> String {
        var output = ""
        var index = 0
        while index < lines.count {
            if isQuoted(lines[index]) {
                var quoted: [String] = []
                while index < lines.count, isQuoted(lines[index]) {
                    quoted.append(unquote(lines[index]))
                    index += 1
                }
                output += "<blockquote>\(quotedLines(quoted))</blockquote>"
            } else {
                var plain: [String] = []
                while index < lines.count, !isQuoted(lines[index]) {
                    plain.append(lines[index])
                    index += 1
                }
                // A blockquote is a block, so the line break before it is implied.
                output += plain.map(linkified).joined(separator: "\n")
            }
        }
        return output
    }

    private static func isQuoted(_ line: String) -> Bool {
        line.drop { $0 == " " }.first == ">"
    }

    private static func unquote(_ line: String) -> String {
        var trimmed = line.drop { $0 == " " }.dropFirst()
        if trimmed.first == " " { trimmed = trimmed.dropFirst() }
        return String(trimmed)
    }

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    private static func linkified(_ line: String) -> String {
        guard let detector = linkDetector else { return escaped(line) }
        let nsLine = line as NSString
        var output = ""
        var cursor = 0
        for match in detector.matches(in: line, range: NSRange(location: 0, length: nsLine.length)) {
            guard let url = match.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { continue }
            output += escaped(nsLine.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            let label = nsLine.substring(with: match.range)
            output += "<a href=\"\(escaped(url.absoluteString))\">\(escaped(label))</a>"
            cursor = match.range.location + match.range.length
        }
        output += escaped(nsLine.substring(from: cursor))
        return output
    }

    static func escaped(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: - Palette

    private struct Palette {
        let canvas: String
        let text: String
        let secondary: String
        let link: String
        let rule: String

        init(appearance: MailHTMLAppearance, isDark: Bool) {
            let dark = isDark && appearance != .original
            canvas = appearance == .original ? "#ffffff" : "transparent"
            text = dark ? "#f5f5f7" : "#000000"
            secondary = dark ? "rgba(235, 235, 245, 0.68)" : "rgba(60, 60, 67, 0.75)"
            link = dark ? "#4da3ff" : "#0066cc"
            rule = dark ? "rgba(235, 235, 245, 0.28)" : "rgba(60, 60, 67, 0.29)"
        }
    }

    // MARK: - Regex helpers

    private static let styleAttribute = try! NSRegularExpression(
        pattern: #"(\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'))"#, options: [.caseInsensitive])
    private static let styleBlock = try! NSRegularExpression(
        pattern: #"((<style\b[^>]*>)([\s\S]*?)(</style\s*>))"#, options: [.caseInsensitive])
    private static let fontColorAttribute = try! NSRegularExpression(
        pattern: #"((<font\b[^>]*?\s)color\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))"#, options: [.caseInsensitive])
    private static let colorDeclaration = try! NSRegularExpression(
        pattern: #"((^|[;{\s"'])color\s*:\s*([^;}!"']+?)\s*(!important)?\s*(?=[;}"']|$))"#, options: [.caseInsensitive])
    private static let backgroundDeclaration = try! NSRegularExpression(
        pattern: #"(?:^|[;{\s"'])background(?:-color|-image)?\s*:\s*([^;}"']+)"#, options: [.caseInsensitive])

    private struct RegexMatch {
        /// Index 0 is the whole match; later indexes are capture groups (nil when unmatched).
        let captures: [String?]
    }

    private static func matches(of regex: NSRegularExpression, in string: String) -> [RegexMatch] {
        let nsString = string as NSString
        return regex.matches(in: string, range: NSRange(location: 0, length: nsString.length)).map { result in
            RegexMatch(captures: (0..<result.numberOfRanges).map { index in
                let range = result.range(at: index)
                return range.location == NSNotFound ? nil : nsString.substring(with: range)
            })
        }
    }

    /// Replaces every match whose transform returns a string; `nil` keeps the original text.
    /// Capture indexes passed to `transform` are shifted so that index 0 is the whole match.
    private static func replacing(_ regex: NSRegularExpression, in string: String, transform: (RegexMatch) -> String?) -> String {
        let nsString = string as NSString
        let results = regex.matches(in: string, range: NSRange(location: 0, length: nsString.length))
        guard !results.isEmpty else { return string }
        var output = ""
        var cursor = 0
        for result in results {
            let captures = (0..<result.numberOfRanges).map { index -> String? in
                let range = result.range(at: index)
                return range.location == NSNotFound ? nil : nsString.substring(with: range)
            }
            // Group 1 wraps each pattern, so drop the duplicate whole-match capture.
            let match = RegexMatch(captures: [captures[0]] + captures.dropFirst(2))
            output += nsString.substring(with: NSRange(location: cursor, length: result.range.location - cursor))
            output += transform(match) ?? nsString.substring(with: result.range)
            cursor = result.range.location + result.range.length
        }
        output += nsString.substring(from: cursor)
        return output
    }

    private static func cssFragments(in html: String) -> [String] {
        let attributes = matches(of: styleAttribute, in: html).compactMap { $0.captures[2] ?? $0.captures[3] }
        let blocks = matches(of: styleBlock, in: html).compactMap { $0.captures[3] }
        return attributes + blocks
    }
}

/// A parsed CSS color in sRGB.
struct CSSColor: Equatable, Sendable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double = 1

    init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    init?(_ rawValue: String) {
        let value = rawValue.replacingOccurrences(of: "!important", with: "", options: .caseInsensitive)
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("#") {
            self.init(hex: String(value.dropFirst()))
        } else if value.hasPrefix("rgb") {
            self.init(functional: value)
        } else if let named = CSSColor.named[value] {
            self = named
        } else if value.count == 6, value.allSatisfy(\.isHexDigit) {
            // Legacy attributes such as `bgcolor=ffffff` omit the hash.
            self.init(hex: value)
        } else {
            return nil
        }
    }

    private init?(hex: String) {
        let digits: [Character]
        switch hex.count {
        case 3, 4: digits = hex.flatMap { [$0, $0] }
        case 6, 8: digits = Array(hex)
        default: return nil
        }
        guard let raw = UInt64(String(digits), radix: 16) else { return nil }
        let hasAlpha = digits.count == 8
        red = Double((raw >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        green = Double((raw >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        blue = Double((raw >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        alpha = hasAlpha ? Double(raw & 0xff) / 255 : 1
    }

    private init?(functional value: String) {
        guard let open = value.firstIndex(of: "("), let close = value.lastIndex(of: ")") else { return nil }
        let parts = value[value.index(after: open)..<close]
            .split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard parts.count >= 3 else { return nil }
        func channel(_ part: String) -> Double? {
            if part.hasSuffix("%") { return Double(part.dropLast()).map { $0 / 100 } }
            return Double(part).map { $0 / 255 }
        }
        guard let red = channel(parts[0]), let green = channel(parts[1]), let blue = channel(parts[2]) else { return nil }
        self.red = min(max(red, 0), 1)
        self.green = min(max(green, 0), 1)
        self.blue = min(max(blue, 0), 1)
        if parts.count >= 4 {
            let part = parts[3]
            alpha = part.hasSuffix("%") ? (Double(part.dropLast()) ?? 100) / 100 : Double(part) ?? 1
        }
    }

    var hex: String {
        String(format: "#%02x%02x%02x", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
    }

    var relativeLuminance: Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    func contrast(with other: CSSColor) -> Double {
        let lighter = max(relativeLuminance, other.relativeLuminance)
        let darker = min(relativeLuminance, other.relativeLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private var hsl: (hue: Double, saturation: Double, lightness: Double) {
        let maximum = max(red, green, blue)
        let minimum = min(red, green, blue)
        let lightness = (maximum + minimum) / 2
        guard maximum != minimum else { return (0, 0, lightness) }
        let delta = maximum - minimum
        let saturation = lightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum)
        var hue: Double
        if maximum == red { hue = (green - blue) / delta + (green < blue ? 6 : 0) }
        else if maximum == green { hue = (blue - red) / delta + 2 }
        else { hue = (red - green) / delta + 4 }
        hue /= 6
        return (hue, saturation, lightness)
    }

    var saturation: Double { hsl.saturation }
    var lightness: Double { hsl.lightness }

    func withLightness(_ lightness: Double) -> CSSColor {
        let (hue, saturation, _) = hsl
        let l = min(max(lightness, 0), 1)
        guard saturation > 0 else { return CSSColor(red: l, green: l, blue: l, alpha: alpha) }
        let q = l < 0.5 ? l * (1 + saturation) : l + saturation - l * saturation
        let p = 2 * l - q
        func channel(_ t: Double) -> Double {
            var t = t
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            if t < 1.0 / 6 { return p + (q - p) * 6 * t }
            if t < 1.0 / 2 { return q }
            if t < 2.0 / 3 { return p + (q - p) * (2.0 / 3 - t) * 6 }
            return p
        }
        return CSSColor(red: channel(hue + 1.0 / 3), green: channel(hue), blue: channel(hue - 1.0 / 3), alpha: alpha)
    }

    private static let named: [String: CSSColor] = {
        let table: [String: UInt32] = [
            "black": 0x000000, "windowtext": 0x000000, "white": 0xffffff, "window": 0xffffff,
            "gray": 0x808080, "grey": 0x808080, "darkgray": 0xa9a9a9, "darkgrey": 0xa9a9a9,
            "dimgray": 0x696969, "dimgrey": 0x696969, "silver": 0xc0c0c0, "lightgray": 0xd3d3d3,
            "lightgrey": 0xd3d3d3, "gainsboro": 0xdcdcdc, "whitesmoke": 0xf5f5f5,
            "red": 0xff0000, "darkred": 0x8b0000, "maroon": 0x800000, "firebrick": 0xb22222,
            "crimson": 0xdc143c, "orange": 0xffa500, "darkorange": 0xff8c00, "yellow": 0xffff00,
            "gold": 0xffd700, "olive": 0x808000, "green": 0x008000, "darkgreen": 0x006400,
            "lime": 0x00ff00, "teal": 0x008080, "navy": 0x000080, "darkblue": 0x00008b,
            "mediumblue": 0x0000cd, "blue": 0x0000ff, "royalblue": 0x4169e1, "steelblue": 0x4682b4,
            "purple": 0x800080, "indigo": 0x4b0082, "darkslategray": 0x2f4f4f, "darkslategrey": 0x2f4f4f,
            "slategray": 0x708090, "midnightblue": 0x191970, "brown": 0xa52a2a, "saddlebrown": 0x8b4513,
            "aqua": 0x00ffff, "cyan": 0x00ffff, "fuchsia": 0xff00ff, "magenta": 0xff00ff,
            "pink": 0xffc0cb, "beige": 0xf5f5dc, "ivory": 0xfffff0, "snow": 0xfffafa,
        ]
        var colors = table.mapValues { value in
            CSSColor(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255,
                     blue: Double(value & 0xff) / 255)
        }
        colors["transparent"] = CSSColor(red: 0, green: 0, blue: 0, alpha: 0)
        return colors
    }()
}

/// A parsed `mailto:` link.
struct MailtoLink: Equatable, Sendable {
    var to: [String] = []
    var cc: [String] = []
    var bcc: [String] = []
    var subject = ""
    var body = ""

    init?(url: URL) {
        guard url.scheme?.lowercased() == "mailto",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        func addresses(_ value: String?) -> [String] {
            (value ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        to = addresses(components.path.removingPercentEncoding ?? components.path)
        for item in components.queryItems ?? [] {
            switch item.name.lowercased() {
            case "to": to += addresses(item.value)
            case "cc": cc += addresses(item.value)
            case "bcc": bcc += addresses(item.value)
            case "subject": subject = item.value ?? ""
            case "body": body = item.value ?? ""
            default: break
            }
        }
    }
}

/// What tapping a link inside a message does.
enum MailLinkAction: Equatable, Sendable {
    case openExternally(URL)
    case compose(MailtoLink)
    case ignore

    static func forActivatedLink(_ url: URL) -> MailLinkAction {
        switch url.scheme?.lowercased() {
        case "mailto": MailtoLink(url: url).map(MailLinkAction.compose) ?? .ignore
        case "http", "https", "tel", "facetime", "maps": .openExternally(url)
        default: .ignore
        }
    }
}
