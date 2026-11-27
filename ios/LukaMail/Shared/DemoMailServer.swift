import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// In-process offline mail server used for interactive Demo Mode (and DEBUG launch verification).
enum MailDemo {
    static var isEnabled: Bool {
        #if DEBUG
        UserDefaults.standard.bool(forKey: "LukaMailDemo")
        #else
        false
        #endif
    }

    static let endpoint = "https://demo.mail.invalid"

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DemoURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    static var cacheDirectory: URL {
        FileManager.default.temporaryDirectory.appending(path: "lmailDemoCache", directoryHint: .isDirectory)
    }
}

final class DemoURLProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        let body = Self.bodyData(of: request)
        let response = DemoMailServer.shared.respond(to: request, body: body)
        let deliver: @Sendable () -> Void = { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let isStopped = self.stopped
            self.lock.unlock()
            guard !isStopped, let url = request.url,
                  let http = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": response.contentType]) else { return }
            self.client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: response.data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + response.delay, execute: deliver)
    }

    override func stopLoading() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    private static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class DemoMailServer: @unchecked Sendable {
    static let shared = DemoMailServer()

    struct Response: Sendable {
        var status = 200
        var contentType = "application/json"
        var data = Data()
        var delay: TimeInterval = 0.15
    }

    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var details: [MailDetail]
    private var drafts: [Draft]
    private var contacts: [MailContact]
    private var attachmentData: [String: Data]

    static let identities = [
        MailIdentity(address: "alex@example.com", displayName: "Alex Rivera", avatarColor: "#0a84ff"),
        MailIdentity(address: "alex.rivera@example.org", displayName: "Alex Rivera (Work)", avatarColor: "#30b0c7"),
    ]

    private init() {
        let fixtures = DemoFixtures.make()
        details = fixtures.details
        drafts = fixtures.drafts
        contacts = fixtures.contacts
        attachmentData = fixtures.attachments
    }

    /// Restores the demo mailbox to its initial synthetic fixture set.
    func reset() {
        lock.lock()
        defer { lock.unlock() }
        let fixtures = DemoFixtures.make()
        details = fixtures.details
        drafts = fixtures.drafts
        contacts = fixtures.contacts
        attachmentData = fixtures.attachments
    }

    func respond(to request: URLRequest, body: Data?) -> Response {
        lock.lock()
        defer { lock.unlock() }
        guard let url = request.url else { return Response(status: 400) }
        let method = request.httpMethod ?? "GET"
        let query = Dictionary(
            (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { _, last in last }
        )
        let parts = url.path.split(separator: "/").map(String.init).map { $0.removingPercentEncoding ?? $0 }
        guard parts.first == "v1", parts.count >= 2 else { return Response(status: 404) }
        let identity = query["identity"] ?? Self.identities[0].address

        let route = Array(parts.dropFirst())
        let first = route.first ?? "", second = route.count > 1 ? route[1] : "", third = route.count > 2 ? route[2] : ""
        switch (method, route.count, first, second, third) {
        case ("GET", 1, "whoami", _, _):
            return json(WhoAmI(principal: .init(keyId: "demo", name: "Alex (Demo)", scopes: ["mail:read", "mail:send"],
                                                allowedIdentities: nil), owner: "alex"))
        case ("GET", 1, "addresses", _, _):
            return json(IdentityResponse(addresses: Self.identities))
        case ("GET", 1, "mailbox-state", _, _):
            var response = json(MailboxState(revision: "demo-1", changed: false))
            response.delay = min(Double(query["wait"] ?? "0") ?? 0, 25)
            return response
        case ("GET", 1, "mailbox-snapshot", _, _):
            let folder = Mailbox(rawValue: query["folder"] ?? "inbox") ?? .inbox
            return json(MailboxSnapshot(
                revision: "demo-1", summary: summary(identity: identity),
                messages: messages(in: folder, identity: identity, query: query["query"] ?? ""),
                nextCursor: nil, drafts: drafts.filter { $0.from == identity },
                addresses: query["includeAddresses"] == "1" ? Self.identities : nil
            ))
        case ("GET", 1, "mailbox-delta", _, _):
            return json(MailboxDelta(identity: identity, fromRevision: "demo-1", revision: "demo-1", changes: [],
                                     summary: summary(identity: identity), hasMore: false, nextCursor: nil,
                                     resetRequired: false, reason: nil))
        case ("GET", 1, "messages", _, _):
            let folder = Mailbox(rawValue: query["folder"] ?? "inbox") ?? .inbox
            return json(MessagePage(messages: messages(in: folder, identity: identity, query: query["query"] ?? ""),
                                    nextCursor: nil))
        case ("GET", 2, "messages", let id, _):
            guard let detail = details.first(where: { $0.id == id }) else { return Response(status: 404) }
            return json(detail)
        case ("GET", 3, "messages", let id, "raw"):
            guard let detail = details.first(where: { $0.id == id }) else { return Response(status: 404) }
            let raw = "From: \(detail.sender.address)\r\nSubject: \(detail.subject)\r\n\r\n\(detail.text ?? detail.preview)"
            return Response(contentType: "message/rfc822", data: Data(raw.utf8))
        case ("GET", 3, "messages", _, "sender-logo"):
            return Response(status: 404)
        case ("PATCH", 2, "messages", let id, _):
            if let update = body.flatMap({ try? decoder.decode(MessageUpdate.self, from: $0) }),
               let index = details.firstIndex(where: { $0.id == id }) {
                if let unread = update.unread { details[index].unread = unread }
                if let starred = update.starred { details[index].starred = starred }
                if let folder = update.folder { details[index].folder = folder }
            }
            return json(UpdatedMessage(updated: true))
        case ("POST", 2, "messages", "send", _):
            return json(SentMessage(sent: true, id: UUID().uuidString, messageId: "<demo@mail.invalid>", status: "sent"))
        case ("GET", 1, "drafts", _, _):
            return json(DraftResponse(drafts: drafts.filter { $0.from == identity }))
        case ("PUT", 1, "drafts", _, _):
            guard var draft = body.flatMap({ try? decoder.decode(Draft.self, from: $0) }) else { return Response(status: 400) }
            let id = draft.id ?? "draft-\(UUID().uuidString.prefix(8))"
            draft.id = id
            draft.updatedAt = Date.now.formatted(.iso8601)
            drafts.removeAll { $0.id == id }
            drafts.insert(draft, at: 0)
            return json(SavedDraft(saved: true, id: id))
        case ("DELETE", 2, "drafts", let id, _):
            drafts.removeAll { $0.id == id }
            return json(DeletedDraft(deleted: true))
        case ("GET", 1, "contacts", _, _):
            return json(ContactResponse(contacts: contacts.filter { $0.identityAddress == identity }))
        case ("POST", 1, "contacts", _, _):
            guard let request = body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: String] }),
                  let address = request["address"] else { return Response(status: 400) }
            let contact = DemoFixtures.contact(address, name: request["displayName"], identity: request["identity"] ?? identity, count: 0)
            contacts.insert(contact, at: 0)
            return json(ContactMutationResponse(contact: contact))
        case ("PATCH", 2, "contacts", let address, _):
            guard let index = contacts.firstIndex(where: { $0.address == address }) else { return Response(status: 404) }
            let name = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["displayName"]
            let old = contacts[index]
            contacts[index] = DemoFixtures.contact(old.address, name: name, identity: old.identityAddress, count: old.sendCount)
            return json(ContactMutationResponse(contact: contacts[index]))
        case ("DELETE", 2, "contacts", let address, _):
            contacts.removeAll { $0.address == address && $0.identityAddress == identity }
            return json(DeletedContact(deleted: true))
        case ("GET", 2, "attachments", let id, _):
            guard let data = attachmentData[id] else { return Response(status: 404) }
            return Response(contentType: "application/octet-stream", data: data)
        case ("POST", 1, "logo-backfill", _, _):
            return json(LogoBackfillPage(processed: 0, nextCursor: nil))
        case ("PUT", 1, "push-devices", _, _):
            return json(PushDeviceResponse(registered: true, identities: Self.identities.map(\.address)))
        case ("DELETE", 1, "push-devices", _, _):
            return json(PushDeviceRemovalResponse(removed: true))
        default:
            return Response(status: 404, data: Data(#"{"error":"Not found in demo server"}"#.utf8))
        }
    }

    private func json<Value: Encodable>(_ value: Value) -> Response {
        Response(data: (try? encoder.encode(value)) ?? Data())
    }

    private func messages(in folder: Mailbox, identity: String, query: String) -> [MailMessage] {
        details
            .filter { $0.recipientsIdentity == identity || identity == Self.identities[0].address && $0.recipientsIdentity.isEmpty }
            .filter { detail in
                switch folder {
                case .starred: detail.starred && detail.folder != "trash"
                case .drafts: false
                default: detail.folder == folder.rawValue
                }
            }
            .filter { detail in
                query.isEmpty || detail.subject.localizedCaseInsensitiveContains(query)
                    || detail.preview.localizedCaseInsensitiveContains(query)
                    || detail.sender.label.localizedCaseInsensitiveContains(query)
            }
            .sorted { $0.receivedAt > $1.receivedAt }
            .map(\.listMessage)
    }

    private func summary(identity: String) -> MailSummary {
        let mine = details.filter { $0.recipientsIdentity == identity || identity == Self.identities[0].address && $0.recipientsIdentity.isEmpty }
        return MailSummary(
            unread: mine.filter { $0.folder == "inbox" && $0.unread }.count,
            inbox: mine.filter { $0.folder == "inbox" }.count,
            sent: mine.filter { $0.folder == "sent" }.count,
            starred: mine.filter { $0.starred && $0.folder != "trash" }.count,
            archive: mine.filter { $0.folder == "archive" }.count,
            trash: mine.filter { $0.folder == "trash" }.count,
            drafts: drafts.filter { $0.from == identity }.count
        )
    }
}

private extension MailDetail {
    /// Demo-only routing: messages addressed to the work identity belong to that mailbox.
    var recipientsIdentity: String {
        let work = DemoMailServer.identities[1].address
        return (recipients + [sender]).contains { $0.address == work } ? work : ""
    }

    var listMessage: MailMessage {
        MailMessage(id: id, threadId: threadId, direction: direction, folder: folder, subject: subject, sender: sender,
                    recipients: recipients, preview: preview, receivedAt: receivedAt, unread: unread, starred: starred,
                    hasAttachments: hasAttachments, attachmentCount: attachmentCount,
                    storedAttachmentCount: storedAttachmentCount, attachmentsTruncated: attachmentsTruncated, size: size)
    }
}

private enum DemoFixtures {
    struct Bundle {
        let details: [MailDetail]
        let drafts: [Draft]
        let contacts: [MailContact]
        let attachments: [String: Data]
    }

    static let me = MailAddress(name: "Alex Rivera", address: "alex@example.com")
    static let work = MailAddress(name: "Alex Rivera", address: "alex.rivera@example.org")

    static func make() -> Bundle {
        let banner = bannerPNG()
        var details: [MailDetail] = []
        func add(_ id: String, folder: String = "inbox", hoursAgo: Double, from sender: MailAddress, to recipients: [MailAddress] = [me],
                 cc: [MailAddress] = [], subject: String, preview: String, text: String? = nil, html: String? = nil,
                 unread: Bool = false, starred: Bool = false, attachments: [MailAttachment] = [], outbound: Bool = false,
                 thread: String? = nil) {
            let date = Date.now.addingTimeInterval(-hoursAgo * 3_600).formatted(.iso8601)
            details.append(MailDetail(
                id: id, threadId: thread ?? id, direction: outbound ? "outbound" : "inbound", folder: folder, subject: subject,
                sender: sender, recipients: recipients, preview: preview, receivedAt: date, unread: unread, starred: starred,
                hasAttachments: attachments.contains { $0.disposition == "attachment" },
                attachmentCount: attachments.count, storedAttachmentCount: attachments.count, attachmentsTruncated: false,
                size: (html ?? text ?? "").utf8.count, messageId: "<\(id)@demo>", inReplyTo: nil, cc: cc, text: text, html: html,
                attachments: attachments, thread: [], threadTruncated: false
            ))
        }

        add("newsletter", hoursAgo: 0.4, from: MailAddress(name: "Swift Weekly", address: "news@swiftweekly.example"),
            subject: "Liquid Glass in Practice — Issue #212",
            preview: "This week: adopting Liquid Glass, scroll edge effects and the new toolbar APIs.",
            html: newsletterHTML, unread: true)
        add("work-reply", hoursAgo: 2, from: MailAddress(name: "Jordan Lee", address: "jordan@example.org"),
            to: [work], cc: [MailAddress(name: "Design Ops", address: "ops@example.org")],
            subject: "Re: Q4 Design Review",
            preview: "Hi Alex, thanks for confirming. The design review starts Monday at 9:00 AM in Room B 204.",
            html: zimbraHTML, unread: true, starred: true, thread: "work")
        add("plain", hoursAgo: 5, from: MailAddress(name: "Sam Patel", address: "sam@example.com"),
            subject: "Re: Server move this weekend",
            preview: "Sounds good. I'll take the backup before we start. See the checklist at https://example.com/checklist",
            text: plainText, attachments: [MailAttachment(id: "att-notes", filename: "migration-notes.txt",
                                                            contentType: "text/plain", contentId: nil, size: 2_418,
                                                            disposition: "attachment")])
        add("outlook", hoursAgo: 26, from: MailAddress(name: "Elena Morales", address: "elena.morales@studio.example"),
            subject: "Proposal and schedule",
            preview: "Hi Alex, attached is the proposal we discussed. Please let me know by Friday.",
            html: outlookHTML, starred: true,
            attachments: [MailAttachment(id: "att-offer", filename: "Proposal-2026-114.txt", contentType: "text/plain",
                                         contentId: nil, size: 48_120, disposition: "attachment")])
        add("dark", hoursAgo: 50, from: MailAddress(name: "Nightly Builds", address: "ci@builds.example"),
            subject: "Build #4821 succeeded", preview: "All 412 tests passed in 3m 12s on main.", html: darkHTML)
        add("wide-table", hoursAgo: 75, from: MailAddress(name: "Billing", address: "billing@hosting.example"),
            subject: "Your September invoice",
            preview: "Invoice 2026-09 for 4 services. Total due: $41.80.", html: wideTableHTML, unread: true)
        add("inline-image", hoursAgo: 120, from: MailAddress(name: "Photo Club", address: "club@photos.example"),
            subject: "Photo of the week", preview: "This week's winner, with the original attached inline.",
            html: inlineImageHTML,
            attachments: [MailAttachment(id: "att-banner", filename: "banner.png", contentType: "image/png",
                                         contentId: "banner@demo", size: banner.count, disposition: "inline")])
        add("native-dark", hoursAgo: 200, from: MailAddress(name: "Status Page", address: "status@service.example"),
            subject: "Scheduled maintenance completed",
            preview: "The maintenance window finished early. All systems are operational.", html: nativeDarkHTML)
        add("github", hoursAgo: 400, from: MailAddress(name: "GitHub", address: "notifications@github.example"),
            subject: "[lmail] Pull request merged (#87)",
            preview: "Merged #87 into main. Render mail bodies on a light card when they set their own colors.",
            html: githubHTML)

        add("sent-1", folder: "sent", hoursAgo: 3, from: me, to: [MailAddress(name: "Sam Patel", address: "sam@example.com")],
            subject: "Server move this weekend", preview: "Hi Sam, are you around on Saturday to help move the server?",
            text: "Hi Sam,\n\nare you around on Saturday to help move the server?\n\nAlex", outbound: true)
        add("sent-2", folder: "sent", hoursAgo: 30, from: work, to: [MailAddress(name: "Jordan Lee", address: "jordan@example.org")],
            subject: "Q4 Design Review", preview: "Hi Jordan, I'd like to confirm my slot for the Q4 design review.",
            text: "Hi Jordan,\n\nI'd like to confirm my slot for the Q4 design review.\n\nBest,\nAlex", outbound: true,
            thread: "work")
        add("archive-1", folder: "archive", hoursAgo: 700, from: MailAddress(name: "Rail Express", address: "noreply@rail.example"),
            subject: "Your train ticket", preview: "Your booking is confirmed. Have a pleasant journey!", text: "Your booking is confirmed.\n\nHave a pleasant journey!")
        add("trash-1", folder: "trash", hoursAgo: 900, from: MailAddress(name: "Deals", address: "deals@shop.example"),
            subject: "Last chance: 50% off", preview: "Only today: half price on everything.", text: "Only today: half price on everything.")

        let drafts = [
            Draft(id: "draft-1", from: me.address, replyToMessageId: nil, to: ["sam@example.com"], cc: [], bcc: [],
                  subject: "Checklist for Saturday", text: "1. Backup\n2. Power down\n3. Move rack",
                  updatedAt: Date.now.addingTimeInterval(-3_600).formatted(.iso8601)),
            Draft(id: "draft-2", from: me.address, replyToMessageId: nil, to: [], cc: [], bcc: [], subject: "",
                  text: "Ideas for the mail app redesign", updatedAt: Date.now.addingTimeInterval(-90_000).formatted(.iso8601)),
        ]
        let contacts = [
            contact("sam@example.com", name: "Sam Patel", identity: me.address, count: 14),
            contact("elena.morales@studio.example", name: "Elena Morales", identity: me.address, count: 6),
            contact("taylor@example.com", name: "Taylor Chen", identity: me.address, count: 31),
            contact("support@hosting.example", name: nil, identity: me.address, count: 1),
            contact("jordan@example.org", name: "Jordan Lee", identity: work.address, count: 3),
        ]
        let notes = Data("Migration checklist\n\n- Back up the database\n- Power down the rack\n- Move and re-cable\n".utf8)
        return Bundle(details: details, drafts: drafts, contacts: contacts,
                      attachments: ["att-notes": notes, "att-offer": notes, "att-banner": banner])
    }

    static func contact(_ address: String, name: String?, identity: String, count: Int) -> MailContact {
        let now = Date.now.formatted(.iso8601)
        return MailContact(identityAddress: identity, address: address, displayName: name?.isEmpty == true ? nil : name,
                           avatarColor: ["#0a84ff", "#5e5ce6", "#30b0c7", "#ff375f", "#bf5af2"][address.utf8.reduce(0) { $0 + Int($1) } % 5],
                           source: "demo", sendCount: count, firstSentAt: now, lastSentAt: now, createdAt: now, updatedAt: now)
    }

    /// A 1200 x 400 gradient PNG used as an inline (cid:) image.
    static func bannerPNG() -> Data {
        let width = 1_200, height = 400
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                                        colors: [CGColor(red: 0.98, green: 0.55, blue: 0.2, alpha: 1),
                                                 CGColor(red: 0.55, green: 0.2, blue: 0.75, alpha: 1)] as CFArray,
                                        locations: [0, 1]) else { return Data() }
        context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: width, y: height), options: [])
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.85))
        context.fillEllipse(in: CGRect(x: 820, y: 120, width: 160, height: 160))
        guard let image = context.makeImage() else { return Data() }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return Data() }
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
        return data as Data
    }

    static let newsletterHTML = """
    <html><head><style>
    .wrapper { background-color: #eef1f5; }
    .card { background: #ffffff; border-radius: 12px; }
    .button { background-color: #0b5cad; color: #ffffff !important; padding: 12px 22px; border-radius: 22px; text-decoration: none; display: inline-block; font-weight: 600; }
    </style></head><body style="margin:0">
    <table role="presentation" class="wrapper" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding: 24px 0;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="card">
      <tr><td bgcolor="#0b5cad" style="padding: 28px 32px; color: #ffffff; font-family: Helvetica, Arial, sans-serif;">
        <div style="font-size: 13px; letter-spacing: 1px; opacity: 0.8;">SWIFT WEEKLY · ISSUE 212</div>
        <div style="font-size: 28px; font-weight: bold; margin-top: 6px;">Liquid Glass in Practice</div>
      </td></tr>
      <tr><td><img src="https://images.example.com/hero.jpg" width="600" height="240" alt="Hero image" style="display:block"></td></tr>
      <tr><td style="padding: 24px 32px; font-family: Helvetica, Arial, sans-serif; font-size: 16px; line-height: 24px; color: #333333;">
        <h2 style="color:#111111; margin-top:0">Adopting the new design</h2>
        <p>This week we look at the functional layer: toolbars, tab bars and sheets that float above content. Keep custom glass to a few important controls.</p>
        <table role="presentation" width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse; margin: 12px 0;">
          <tr style="background:#f5f7fa"><td style="border-bottom:1px solid #dde3ea"><b>Topic</b></td><td style="border-bottom:1px solid #dde3ea"><b>API</b></td></tr>
          <tr><td style="border-bottom:1px solid #eef1f5">Toolbars</td><td style="border-bottom:1px solid #eef1f5"><code>ToolbarSpacer</code></td></tr>
          <tr><td style="border-bottom:1px solid #eef1f5">Edge effects</td><td style="border-bottom:1px solid #eef1f5"><code>scrollEdgeEffectStyle</code></td></tr>
        </table>
        <p style="text-align:center; margin: 28px 0;"><a class="button" href="https://swiftweekly.example/212">Read the Issue</a></p>
        <p style="font-size: 12px; color: #8a8f98;">You receive this because you subscribed at swiftweekly.example. <a href="https://swiftweekly.example/unsubscribe" style="color:#8a8f98">Unsubscribe</a></p>
      </td></tr>
    </table></td></tr></table></body></html>
    """

    static let zimbraHTML = """
    <html><body><div style="font-family: arial, helvetica, sans-serif; font-size: 12pt; color: #000000"><div>Hi Alex,</div><div><br></div><div>thanks for confirming. The <strong>Q4 Design Review</strong> starts Monday at 9:00 AM in Room B&nbsp;204. Please bring your laptop.</div><div><br></div><div>Best,<br>Jordan Lee</div><div><br></div><hr id="zwchr" data-marker="__DIVIDER__"><div data-marker="__HEADERS__"><b>From: </b>"Alex Rivera" &lt;alex.rivera@example.org&gt;<br><b>To: </b>"Jordan Lee" &lt;jordan@example.org&gt;<br><b>Sent: </b>Friday, October 2, 2026 18:12:40<br><b>Subject: </b>Q4 Design Review<br></div><div><br></div><div data-marker="__QUOTED_TEXT__"><blockquote style="border-left:2px solid #1010FF;margin-left:5px;padding-left:5px;color:#000;font-weight:normal;font-style:normal;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:12pt;"><div style="font-family: arial, helvetica, sans-serif; font-size: 12pt; color: #000000">Hi Jordan,<br><br>I'd like to confirm my slot for the Q4 design review.<br><br>Best,<br>Alex</div></blockquote></div></div></body></html>
    """

    static let plainText = """
    Sounds good. I'll take the backup before we start.

    See the checklist at https://example.com/checklist and ping me at sam@example.com if anything changes.

    On Saturday, 3 Oct 2026 at 18:04, Alex Rivera wrote:
    > Hi Sam,
    >
    > are you around on Saturday to help move the server?
    >> Earlier: the rack needs two people.
    >
    > Alex

    --
    Sam
    """

    static let outlookHTML = """
    <html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <style><!--
    p.MsoNormal, li.MsoNormal, div.MsoNormal { margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif; color:windowtext; }
    a:link, span.MsoHyperlink { mso-style-priority:99; color:#0563C1; text-decoration:underline; }
    span.EmailStyle17 { mso-style-type:personal-compose; font-family:"Calibri",sans-serif; color:#1F497D; }
    --></style></head>
    <body lang="EN" link="#0563C1" vlink="#954F72" style="word-wrap:break-word">
    <div class="WordSection1">
    <p class="MsoNormal"><span style="color:#1F497D">Hi Alex,<o:p></o:p></span></p>
    <p class="MsoNormal"><span style="color:#1F497D"><o:p>&nbsp;</o:p></span></p>
    <p class="MsoNormal"><span style="color:#1F497D">attached is the proposal we discussed. Please let me know by <b>Friday</b>. Details are also available at <a href="https://studio.example/proposal/114">studio.example/proposal/114</a>.<o:p></o:p></span></p>
    <p class="MsoNormal"><span style="color:#1F497D"><o:p>&nbsp;</o:p></span></p>
    <p class="MsoNormal"><span style="color:black">Best regards,<br>Elena Morales<o:p></o:p></span></p>
    <p class="MsoNormal"><font color="#7f7f7f" size="1">Example Studio · 100 Main Street · Anytown</font></p>
    <div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> Alex Rivera &lt;alex@example.com&gt;<br><b>Sent:</b> Wednesday, September 30, 2026 10:02<br><b>Subject:</b> Proposal</p></div>
    <p class="MsoNormal">Hi Elena, could you send over the updated proposal?</p>
    </div></body></html>
    """

    static let darkHTML = """
    <html><body bgcolor="#111418" text="#e6edf3" style="margin:0; font-family: -apple-system, Helvetica, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#111418"><tr><td style="padding: 28px;">
    <div style="color:#3fb950; font-size: 20px; font-weight: 600;">✓ Build #4821 succeeded</div>
    <p style="color:#e6edf3; font-size: 15px;">All <b>412 tests</b> passed in 3m 12s on <code style="background:#30363d; color:#e6edf3; padding: 2px 6px; border-radius: 6px;">main</code>.</p>
    <p style="color:#8b949e; font-size: 13px;">Commit 9f2c1ab · Triggered by push · <a href="https://builds.example/4821" style="color:#58a6ff">View build</a></p>
    </td></tr></table></body></html>
    """

    static let wideTableHTML = """
    <div style="font-family: Helvetica, Arial, sans-serif;">
    <p>Hello Alex,</p><p>here is your invoice for September 2026.</p>
    <table width="900" cellpadding="6" cellspacing="0" style="border-collapse: collapse; font-size: 14px;">
    <tr><th align="left" style="border-bottom: 2px solid #444">Service</th><th align="left" style="border-bottom: 2px solid #444">Plan</th><th align="left" style="border-bottom: 2px solid #444">Region</th><th align="left" style="border-bottom: 2px solid #444">Period</th><th align="right" style="border-bottom: 2px solid #444">Units</th><th align="right" style="border-bottom: 2px solid #444">Unit&nbsp;price</th><th align="right" style="border-bottom: 2px solid #444">Amount</th></tr>
    <tr><td>Compute&nbsp;Instance&nbsp;CX22</td><td>Shared&nbsp;vCPU</td><td>US-East&nbsp;1</td><td>2026-09-01&nbsp;–&nbsp;2026-09-30</td><td align="right">720&nbsp;h</td><td align="right">$0.0064</td><td align="right">$4.61</td></tr>
    <tr><td>Object&nbsp;Storage</td><td>Standard</td><td>US-East&nbsp;1</td><td>2026-09-01&nbsp;–&nbsp;2026-09-30</td><td align="right">1&nbsp;TB</td><td align="right">$5.99</td><td align="right">$5.99</td></tr>
    <tr><td>Dedicated&nbsp;Server&nbsp;AX42</td><td>Monthly</td><td>EU-Central&nbsp;1</td><td>2026-09-01&nbsp;–&nbsp;2026-09-30</td><td align="right">1</td><td align="right">$29.00</td><td align="right">$29.00</td></tr>
    <tr><td>Floating&nbsp;IPv4</td><td>Primary</td><td>US-East&nbsp;1</td><td>2026-09-01&nbsp;–&nbsp;2026-09-30</td><td align="right">1</td><td align="right">$2.20</td><td align="right">$2.20</td></tr>
    <tr><td colspan="6" align="right" style="border-top: 2px solid #444"><b>Total</b></td><td align="right" style="border-top: 2px solid #444"><b>$41.80</b></td></tr>
    </table>
    <p style="color: #666666; font-size: 12px;">Payment is collected automatically on October 7.</p></div>
    """

    static let inlineImageHTML = """
    <div dir="ltr" style="font-family: Georgia, serif; font-size: 17px;">
    <p>This week's winner is <i>“Golden Hour Over the Bay”</i>. Congratulations!</p>
    <p><img src="cid:banner@demo" width="1200" height="400" alt="Winning photo"></p>
    <div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Sep 28, 2026 at 9:14 AM Photo Club wrote:<br></div>
    <blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">Voting closes on Friday.</blockquote></div></div>
    """

    static let nativeDarkHTML = """
    <html><head><meta name="color-scheme" content="light dark"><style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, sans-serif; background: #ffffff; color: #1d1d1f; }
    .status { background: #e8f8ee; color: #0a6b32; padding: 12px 16px; border-radius: 10px; }
    @media (prefers-color-scheme: dark) {
      body { background: #000000; color: #f5f5f7; }
      .status { background: #0f2d1b; color: #63e08f; }
    }
    </style></head><body>
    <div class="status"><b>Operational</b> — all systems are running normally.</div>
    <p>The scheduled maintenance finished 25 minutes early. No action is required.</p></body></html>
    """

    static let githubHTML = """
    <p>Merged <a href="https://github.example/example/lmail/pull/87">#87</a> into <code>main</code>.</p>
    <p>Render mail bodies on a light card when they set their own colors, and adapt dark text in plain replies.</p>
    <p style="font-size:small;-webkit-text-size-adjust:none;color:#666;">—<br>Reply to this email directly, <a href="https://github.example/example/lmail/pull/87#event-1">view it on GitHub</a>, or <a href="https://github.example/notifications/unsubscribe">unsubscribe</a>.<br>You are receiving this because you authored the thread.</p>
    """
}

/// DEBUG-only launch arguments that open a specific screen for visual verification,
/// e.g. `-LukaMailDemo YES -DemoSheet settings`. Always nil in Release.
enum DemoLaunch {
    static func string(_ key: String) -> String? {
        #if DEBUG
        guard MailDemo.isEnabled else { return nil }
        return UserDefaults.standard.string(forKey: key)
        #else
        return nil
        #endif
    }

    static func flag(_ key: String) -> Bool { string(key) == "YES" }
}
