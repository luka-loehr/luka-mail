import SwiftUI

/// One turn of the conversation: the owner's message as a bubble, or the
/// agent's answer with what it did, the mail it looked at, and the emails it
/// proposed.
struct AgentMessageRow: View {
    @Environment(AgentStore.self) private var agent
    let message: AgentChatMessage
    let isLatest: Bool

    var body: some View {
        switch message.role {
        case .user: userBubble
        case .assistant: assistantBody
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            Text(message.content)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.fill.secondary, in: .rect(cornerRadius: 22))
                .textSelection(.enabled)
        }
    }

    private var working: Bool { isLatest && agent.streaming }

    private var assistantBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !message.activity.isEmpty || working {
                AgentActivityView(activity: message.activity, working: working && message.content.isEmpty,
                                  status: working ? agent.liveStatus : nil)
            }
            if !message.content.isEmpty {
                MarkdownText(source: message.content)
            }
            let sources = message.sources.sorted { $0.read && !$1.read }
            if !sources.isEmpty {
                AgentSourcesView(sources: Array(sources.prefix(10)))
            }
            ForEach(message.drafts) { draft in
                if draft.status == .superseded {
                    SupersededDraftRow(draft: draft)
                } else {
                    AgentDraftCard(draft: draft, showsRevisions: isLatest || draft.status == .draft)
                        .id(draft.id)
                }
            }
            if let error = message.error, error != "incomplete" || !working {
                Label(error == "incomplete" ? "This answer was interrupted." : error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What the agent did, collapsed into one line once it answered.
private struct AgentActivityView: View {
    let activity: [AgentActivity]
    let working: Bool
    let status: String?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if working {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(status ?? "Thinking")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .contentTransition(.opacity)
                        .animation(.default, value: status)
                }
                .accessibilityElement(children: .combine)
            } else if !activity.isEmpty {
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkle.magnifyingglass")
                        Text(summary)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                if expanded {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(Array(activity.enumerated()), id: \.offset) { _, step in
                            Label(step.label, systemImage: Self.symbol(for: step.tool))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.leading, 4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    /// "Searched mail twice, read 2 mails, wrote an email": what happened, in order of first appearance.
    private var summary: String {
        if activity.count == 1 { return activity[0].label }
        var parts: [String] = []
        var seen: Set<String> = []
        for step in activity {
            let kind = Self.kind(of: step.tool)
            guard !seen.contains(kind) else { continue }
            seen.insert(kind)
            let count = activity.filter { Self.kind(of: $0.tool) == kind }.count
            switch kind {
            case "search": parts.append(count == 1 ? "searched mail" : "searched mail \(count == 2 ? "twice" : "\(count) times")")
            case "read": parts.append(count == 1 ? "read 1 mail" : "read \(count) mails")
            case "style": parts.append("checked your earlier mails")
            case "write": parts.append(count == 1 ? "wrote an email" : "wrote \(count) emails")
            case "drafts": parts.append("checked drafts")
            case "contacts": parts.append("checked contacts")
            case "attachment": parts.append(count == 1 ? "read an attachment" : "read \(count) attachments")
            case "update": parts.append(count == 1 ? "updated a mail" : "updated \(count) mails")
            default: parts.append(count == 1 ? "1 more step" : "\(count) more steps")
            }
        }
        return parts.joined(separator: ", ").capitalizedFirst
    }

    private static func kind(of tool: String) -> String {
        switch tool {
        case "semantic_search", "list_messages", "graph_lookup", "mailbox_summary": "search"
        case "read_message", "read_thread": "read"
        case "read_attachment": "attachment"
        case "style_examples": "style"
        case "propose_email": "write"
        case "list_drafts": "drafts"
        case "list_contacts", "save_contact": "contacts"
        case "update_message", "undo_autopilot_action": "update"
        default: "other"
        }
    }

    static func symbol(for tool: String) -> String {
        switch tool {
        case "semantic_search", "list_messages": "magnifyingglass"
        case "read_message", "read_thread": "envelope.open"
        case "read_attachment": "paperclip"
        case "save_contact": "person.crop.circle.badge.plus"
        case "list_identities": "tray.2"
        case "autopilot_log", "undo_autopilot_action": "wand.and.stars"
        case "graph_lookup": "point.3.connected.trianglepath.dotted"
        case "list_contacts": "person.2"
        case "propose_email": "square.and.pencil"
        case "style_examples": "text.quote"
        case "list_drafts": "doc.text"
        case "update_message": "tray.and.arrow.down"
        default: "gearshape"
        }
    }
}

/// The mail the agent looked at; tap one to open it.
private struct AgentSourcesView: View {
    @Environment(\.openMailRoute) private var openMailRoute
    let sources: [AgentSource]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(sources) { source in
                    Button { openMailRoute(.message(source.id)) } label: {
                        HStack(spacing: 8) {
                            Text(String(source.senderName.prefix(1)).uppercased())
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 26, height: 26)
                                .background(Color(hue: Self.hue(source.senderAddress), saturation: 0.55, brightness: 0.8), in: .circle)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(source.senderName).font(.caption.weight(.semibold)).lineLimit(1)
                                Text(source.subject.isEmpty ? "No Subject" : source.subject)
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .frame(maxWidth: 170, alignment: .leading)
                        }
                        .padding(.leading, 6)
                        .padding(.trailing, 12)
                        .padding(.vertical, 6)
                        .background(.fill.tertiary, in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(source.senderName): \(source.subject)")
                }
            }
        }
        .scrollClipDisabled()
    }

    private static func hue(_ value: String) -> Double {
        Double(value.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 360 }) / 360
    }
}

/// An earlier version the agent replaced with a revision.
private struct SupersededDraftRow: View {
    let draft: AgentDraft
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                Label("Earlier version · \(draft.subject.isEmpty ? "No Subject" : draft.subject)", systemImage: "clock.arrow.circlepath")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
            if expanded {
                AgentDraftCard(draft: draft, showsRevisions: false)
            }
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
