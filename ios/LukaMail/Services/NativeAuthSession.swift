import AuthenticationServices
import CryptoKit
import Foundation
import Security
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Normalizes, validates, and persists the user-configured lmail server origin.
enum ServerEndpoint {
    static let defaultsKey = "serverEndpoint"

    /// Normalizes input like `mail.example.com` or `https://mail.example.com/` into a canonical HTTPS origin URL.
    static func normalize(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: candidate),
              components.scheme?.lowercased() == "https",
              let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !host.isEmpty,
              host.contains("."),
              !host.contains(where: \.isWhitespace),
              components.user == nil,
              components.password == nil else {
            return nil
        }
        components.scheme = "https"
        components.host = host
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func saved(in defaults: UserDefaults = .standard) -> URL? {
        guard let raw = defaults.string(forKey: defaultsKey) else { return nil }
        return normalize(raw)
    }

    static func save(_ url: URL, in defaults: UserDefaults = .standard) {
        defaults.set(url.absoluteString, forKey: defaultsKey)
    }

    static func clear(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }

    static func displayHost(for urlString: String) -> String {
        guard let url = URL(string: urlString), let host = url.host else { return urlString }
        if let port = url.port { return "\(host):\(port)" }
        return host
    }
}

@MainActor
final class NativeAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private static let callbackScheme = "lmail"
    private static let acceptedSchemes: Set<String> = ["lmail", "lukamail"]
    private static let redirectURI = "lmail://auth/callback"

    private var session: ASWebAuthenticationSession?

    func signIn(endpoint: URL, platform: NativeAuthPlatform) async throws -> NativeAuthToken {
        let state = try Self.randomURLSafeString(byteCount: 32)
        let verifier = try Self.randomURLSafeString(byteCount: 64)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let authorizeURL = try Self.authorizeURL(endpoint: endpoint, state: state, challenge: challenge, platform: platform)

        let callbackURL = try await authenticate(at: authorizeURL)
        let code = try Self.validatedCode(from: callbackURL, expectedState: state)
        return try await Self.exchange(endpoint: endpoint, code: code, verifier: verifier)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
#if os(iOS)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) {
            return window
        }
        guard let scene = scenes.first else { return ASPresentationAnchor() }
        return ASPresentationAnchor(windowScene: scene)
#elseif os(macOS)
        NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
#endif
    }

    private func authenticate(at url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let callback = ASWebAuthenticationSession.Callback.customScheme(Self.callbackScheme)
            let completion = Self.authenticationCompletion(owner: self, continuation: continuation)
            let session = ASWebAuthenticationSession(url: url, callback: callback, completionHandler: completion)
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: NativeAuthError.couldNotStart)
                return
            }
        }
    }

    /// AuthenticationServices invokes this completion on a Safari XPC queue on macOS.
    /// Constructing it in a nonisolated context prevents Swift from attaching the
    /// enclosing type's MainActor precondition to the callback itself.
    nonisolated static func authenticationCompletion(
        owner: NativeAuthSession,
        continuation: CheckedContinuation<URL, any Error>
    ) -> @Sendable (URL?, (any Error)?) -> Void {
        { [weak owner] callbackURL, error in
            if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                continuation.resume(throwing: NativeAuthError.cancelled)
            } else if let error {
                continuation.resume(throwing: error)
            } else if let callbackURL {
                continuation.resume(returning: callbackURL)
            } else {
                continuation.resume(throwing: NativeAuthError.invalidCallback)
            }

            Task { @MainActor [weak owner] in
                owner?.session = nil
            }
        }
    }

    static func authorizeURL(endpoint: URL, state: String, challenge: String, platform: NativeAuthPlatform) throws -> URL {
        guard endpoint.scheme?.lowercased() == "https", endpoint.host != nil else {
            throw NativeAuthError.invalidServerAddress
        }
        var components = URLComponents(url: endpoint.appending(path: "auth/native/authorize"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "platform", value: platform.rawValue),
        ]
        guard let url = components?.url else { throw NativeAuthError.invalidAuthorizationURL }
        return url
    }

    static func validatedCode(from callbackURL: URL, expectedState: String) throws -> String {
        guard let scheme = callbackURL.scheme?.lowercased(),
              acceptedSchemes.contains(scheme),
              callbackURL.host?.lowercased() == "auth",
              callbackURL.path == "/callback",
              callbackURL.user == nil,
              callbackURL.password == nil,
              callbackURL.port == nil,
              callbackURL.fragment == nil,
              let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            throw NativeAuthError.invalidCallback
        }
        let values = Dictionary(grouping: components.queryItems ?? [], by: \.name)
        guard values["state"]?.count == 1,
              values["state"]?.first?.value == expectedState else {
            throw NativeAuthError.invalidCallback
        }
        if let message = values["error_description"]?.first?.value ?? values["error"]?.first?.value {
            throw NativeAuthError.server(message)
        }
        guard
              values["code"]?.count == 1,
              let code = values["code"]?.first?.value,
              !code.isEmpty else {
            throw NativeAuthError.invalidCallback
        }
        return code
    }

    private static func exchange(endpoint: URL, code: String, verifier: String) async throws -> NativeAuthToken {
        let url = endpoint.appending(path: "auth/native/token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(TokenRequest(code: code, codeVerifier: verifier, redirectUri: redirectURI))
        let (data, response) = try await ephemeralSession().data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeAuthError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error)
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw NativeAuthError.server(message)
        }
        let token = try JSONDecoder().decode(NativeAuthToken.self, from: data)
        guard token.tokenType.caseInsensitiveCompare("Bearer") == .orderedSame,
              !token.accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              token.expiresIn > 0 else { throw NativeAuthError.invalidResponse }
        return token
    }

    static func revoke(endpoint: URL, accessToken: String) async throws {
        var request = URLRequest(url: endpoint.appending(path: "auth/native/logout"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await ephemeralSession(waitsForConnectivity: false).data(for: request)
        guard let http = response as? HTTPURLResponse else { throw NativeAuthError.logoutFailed }
        guard (200..<300).contains(http.statusCode) || http.statusCode == 401 else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error)
            throw message.map(NativeAuthError.server) ?? NativeAuthError.logoutFailed
        }
    }

    private static func ephemeralSession(waitsForConnectivity: Bool = true) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        configuration.waitsForConnectivity = waitsForConnectivity
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return URLSession(configuration: configuration)
    }

    private static func randomURLSafeString(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard result == errSecSuccess else { throw NativeAuthError.secureRandom }
        return base64URL(Data(bytes))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

struct NativeAuthToken: Decodable, Sendable {
    let accessToken: String
    let tokenType: String
    let expiresIn: Int
}

enum NativeAuthPlatform: String, Sendable {
    case ios
    case macos
}

private struct TokenRequest: Encodable {
    let code: String
    let codeVerifier: String
    let redirectUri: String
}

private struct ErrorResponse: Decodable { let error: String }

enum NativeAuthError: LocalizedError, Equatable, Sendable {
    case cancelled
    case invalidServerAddress
    case invalidAuthorizationURL
    case invalidCallback
    case invalidResponse
    case couldNotStart
    case logoutFailed
    case secureRandom
    case server(String)

    var errorDescription: String? {
        switch self {
        case .cancelled: "Sign in was cancelled."
        case .invalidServerAddress: "Enter a valid server address, such as mail.example.com."
        case .invalidAuthorizationURL: "lmail could not create a secure sign-in request."
        case .invalidCallback: "The sign-in response could not be verified. Please try again."
        case .invalidResponse: "The server returned an invalid sign-in response."
        case .couldNotStart: "lmail could not open the secure sign-in window."
        case .logoutFailed: "Signed out on this device, but the server could not confirm revocation. The session expires automatically within 30 days."
        case .secureRandom: "lmail could not create a secure sign-in request."
        case .server(let message): message
        }
    }
}
