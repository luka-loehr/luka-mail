use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use clap::{Args, Parser, Subcommand, ValueEnum};
use reqwest::Method;
use reqwest::blocking::{Client, Response};
use serde_json::{Map, Value, json};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "lmail", version, about = "Self-hosted email CLI for lmail")]
struct Cli {
    #[arg(
        long,
        env = "LMAIL_ENDPOINT",
        global = true,
        help = "Base URL of the lmail server (e.g. https://mail.example.com)"
    )]
    endpoint: Option<String>,
    #[arg(long, global = true, help = "Emit compact machine-readable JSON")]
    json: bool,
    #[arg(
        long,
        default_value = "default",
        global = true,
        help = "Named local credential profile"
    )]
    profile: String,
    #[arg(
        long,
        global = true,
        help = "Assert that the user explicitly approved this administrative mutation"
    )]
    confirm_admin: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Health,
    Doctor(DoctorArgs),
    Deliverability(DeliverabilityArgs),
    Login,
    Logout,
    Whoami,
    Summary,
    #[command(subcommand)]
    Mail(MailCommand),
    #[command(subcommand)]
    Draft(DraftCommand),
    #[command(subcommand)]
    Contact(ContactCommand),
    #[command(subcommand)]
    Address(AddressCommand),
    #[command(subcommand)]
    External(ExternalCommand),
    #[command(
        subcommand,
        about = "The inbox autopilot: triage, rules, reply drafts, daily brief"
    )]
    Autopilot(AutopilotCommand),
    #[command(subcommand)]
    Key(KeyCommand),
    Audit(PageArgs),
}

#[derive(Subcommand)]
enum AutopilotCommand {
    #[command(about = "Settings, rules, spending today and what happened in the last 24 hours")]
    Status,
    #[command(about = "Stop rules, reply drafts and the brief (spam is still flagged)")]
    Pause,
    #[command(about = "Turn the autopilot back on")]
    Resume,
    #[command(about = "Change reply drafts, the daily brief or the daily spending cap")]
    Set(AutopilotSetArgs),
    #[command(subcommand, about = "Rules that act on triaged mail")]
    Rule(RuleCommand),
    #[command(about = "What the autopilot did, newest first")]
    Log(AutopilotLogArgs),
    #[command(about = "Undo one action: its id, or the first 8 characters shown in the brief")]
    Undo {
        #[arg(allow_hyphen_values = true)]
        id: String,
    },
    #[command(about = "Draft a reply to one message now, in the owner's style")]
    Draft {
        #[arg(allow_hyphen_values = true)]
        id: String,
    },
    #[command(about = "Write the daily brief into the inbox now")]
    Brief,
    #[command(
        about = "Triage recent mail that has no verdict yet, and file repeated and resolved alerts"
    )]
    Sweep,
}

#[derive(Args)]
struct AutopilotSetArgs {
    #[arg(long, value_enum)]
    drafts: Option<Toggle>,
    #[arg(long, value_enum)]
    brief: Option<Toggle>,
    #[arg(long, value_parser = parse_daily_cap, help = "Daily cap in USD for triage, drafts and the brief")]
    daily_cap: Option<f64>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Toggle {
    On,
    Off,
}

#[derive(Subcommand)]
enum RuleCommand {
    List,
    Add(RuleAddArgs),
    Enable { id: String },
    Disable { id: String },
    Remove { id: String },
}

#[derive(Args)]
struct RuleAddArgs {
    #[arg(long, value_enum)]
    category: RuleCategory,
    #[arg(long, value_enum)]
    action: RuleAction,
    #[arg(long, help = "Only mail to this address")]
    identity: Option<String>,
    #[arg(long, help = "Only mail from this address or @domain")]
    sender: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(u8).range(0..=3), help = "Leave mail rated more urgent than this (0-3)")]
    max_urgency: Option<u8>,
    #[arg(long, value_parser = parse_confidence, help = "Minimum triage confidence, 0.5 to 1 (default 0.8)")]
    min_confidence: Option<f64>,
}

#[derive(Clone, Copy, ValueEnum)]
enum RuleCategory {
    Personal,
    School,
    Agent,
    Notification,
    Code,
    Receipt,
    Newsletter,
}

#[derive(Clone, Copy, ValueEnum)]
enum RuleAction {
    Archive,
    Read,
    Star,
}

#[derive(Args)]
struct AutopilotLogArgs {
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=200))]
    limit: u16,
    #[arg(long)]
    identity: Option<String>,
}

/// The lowercase name clap shows for a value-enum variant, which is also what the API expects.
fn value_name(value: impl ValueEnum) -> String {
    value
        .to_possible_value()
        .map(|possible| possible.get_name().to_owned())
        .unwrap_or_default()
}

#[derive(Subcommand)]
enum ExternalCommand {
    #[command(about = "Replication state of external (IMAP) accounts")]
    Status,
    #[command(about = "Pull new mail from external accounts into the local store")]
    Sync(ExternalSyncArgs),
}

#[derive(Args)]
struct ExternalSyncArgs {
    #[arg(long, help = "Sync only this external identity")]
    identity: Option<String>,
    #[arg(long, help = "Keep pulling batches until every folder reports done")]
    full: bool,
    #[arg(long, default_value_t = 40, value_parser = clap::value_parser!(u16).range(1..=200))]
    max_messages: u16,
}

#[derive(Args)]
struct DeliverabilityArgs {
    #[arg(long, default_value_t = 24, value_parser = clap::value_parser!(u16).range(1..=168), help = "Analytics window in hours (1-168)")]
    hours: u16,
}

#[derive(Args)]
struct DoctorArgs {
    #[arg(long, help = "Send from every address to itself and verify delivery")]
    loopback: bool,
    #[arg(
        long,
        value_delimiter = ',',
        help = "Limit loopback checks to these addresses"
    )]
    address: Vec<String>,
    #[arg(
        long,
        default_value_t = 120,
        help = "Loopback delivery timeout in seconds"
    )]
    timeout: u64,
}

#[derive(Subcommand)]
enum MailCommand {
    List(MailListArgs),
    Watch(MailWatchArgs),
    Show {
        // Message ids are base64url and may start with "-".
        #[arg(allow_hyphen_values = true)]
        id: String,
    },
    Send(Box<SendArgs>),
    SendStatus {
        idempotency_key: String,
    },
    Update(UpdateArgs),
    Raw {
        #[arg(allow_hyphen_values = true)]
        id: String,
        #[arg(short, long)]
        output: PathBuf,
    },
    Attachment {
        #[arg(allow_hyphen_values = true)]
        id: String,
        #[arg(short, long)]
        output: PathBuf,
    },
}

#[derive(Args)]
struct MailListArgs {
    #[arg(long, help = "Only this mailbox, e.g. billing@example.com")]
    identity: Option<String>,
    #[arg(long, value_enum, default_value = "inbox")]
    folder: Folder,
    #[arg(long)]
    query: Option<String>,
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long)]
    all: bool,
}

#[derive(Args)]
struct MailWatchArgs {
    #[arg(long, value_enum, default_value = "inbox")]
    folder: Folder,
    #[arg(
        long,
        help = "Exact mailbox identity to watch (required; aggregate revision streams are ambiguous)"
    )]
    identity: String,
    #[arg(long)]
    query: Option<String>,
    #[arg(long, default_value_t = 50)]
    limit: u16,
    #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u8).range(1..=25), help = "Long-poll duration; the server checks for changes every second")]
    wait_seconds: u8,
    #[arg(
        long,
        help = "Compatibility mode: download and print the full selected mailbox after every change"
    )]
    full_snapshots: bool,
}

#[derive(Clone, ValueEnum)]
enum Folder {
    Inbox,
    Sent,
    Archive,
    Trash,
    Starred,
    All,
    /// Mail the AI classifier judged to be spam; hidden from every other folder.
    Spam,
}
impl Folder {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Archive => "archive",
            Self::Trash => "trash",
            Self::Starred => "starred",
            Self::All => "all",
            Self::Spam => "spam",
        }
    }
}

#[derive(Args)]
struct SendArgs {
    #[arg(
        long,
        help = "Stable UUID for safe retries; generated automatically when omitted"
    )]
    idempotency_key: Option<String>,
    #[arg(long)]
    from: String,
    #[arg(long, required = true, value_delimiter = ',')]
    to: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    cc: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    bcc: Vec<String>,
    #[arg(long, default_value = "")]
    subject: String,
    #[arg(long, conflicts_with = "body_file")]
    body: Option<String>,
    #[arg(long)]
    body_file: Option<PathBuf>,
    #[arg(long)]
    html_file: Option<PathBuf>,
    #[arg(long, allow_hyphen_values = true)]
    reply_to: Option<String>,
    #[arg(long)]
    attach: Vec<PathBuf>,
}

#[derive(Args)]
struct UpdateArgs {
    #[arg(allow_hyphen_values = true)]
    id: String,
    #[arg(long, conflicts_with = "unread")]
    read: bool,
    #[arg(long, conflicts_with = "read")]
    unread: bool,
    #[arg(long, conflicts_with = "unstar")]
    star: bool,
    #[arg(long, conflicts_with = "star")]
    unstar: bool,
    #[arg(
        long,
        conflicts_with = "not_spam",
        help = "Mark as spam and hide it from the mailbox"
    )]
    spam: bool,
    #[arg(
        long,
        conflicts_with = "spam",
        help = "Clear a false positive and return it to the inbox"
    )]
    not_spam: bool,
    #[arg(long, value_enum)]
    folder: Option<MutableFolder>,
}

#[derive(Clone, ValueEnum)]
enum MutableFolder {
    Inbox,
    Sent,
    Archive,
    Trash,
}
impl MutableFolder {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Sent => "sent",
            Self::Archive => "archive",
            Self::Trash => "trash",
        }
    }
}

#[derive(Subcommand)]
enum DraftCommand {
    List,
    Save(DraftSaveArgs),
    Delete {
        #[arg(allow_hyphen_values = true)]
        id: String,
    },
}

#[derive(Subcommand)]
enum ContactCommand {
    List(ContactListArgs),
    Add {
        address: String,
        #[arg(long)]
        identity: String,
        #[arg(long)]
        name: Option<String>,
    },
    SetName {
        address: String,
        name: String,
        #[arg(long)]
        identity: String,
    },
    Remove {
        address: String,
        #[arg(long)]
        identity: String,
    },
}

#[derive(Args)]
struct ContactListArgs {
    #[arg(long)]
    identity: Option<String>,
    #[arg(long, help = "Rank contacts matching this name or email fragment")]
    query: Option<String>,
    #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u16).range(1..=200))]
    limit: u16,
}

#[derive(Args)]
struct DraftSaveArgs {
    #[arg(long)]
    from: String,
    #[arg(long)]
    id: Option<String>,
    #[arg(long, allow_hyphen_values = true)]
    reply_to: Option<String>,
    #[arg(long, value_delimiter = ',')]
    to: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    cc: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    bcc: Vec<String>,
    #[arg(long, default_value = "")]
    subject: String,
    #[arg(long, conflicts_with = "body_file")]
    body: Option<String>,
    #[arg(long)]
    body_file: Option<PathBuf>,
}

#[derive(Subcommand)]
enum AddressCommand {
    List,
    /// Create a mailbox on any domain or subdomain of a zone in the
    /// Cloudflare account. An unknown domain is set up on the way (zone
    /// lookup, MX and SPF records). Uses the `admin` profile by itself.
    Add {
        address: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(
            long = "grant-key",
            help = "Also let this API key id use the new mailbox (repeatable)"
        )]
        grant_keys: Vec<String>,
        #[arg(
            long,
            help = "Do not give the everyday (default profile) key access to the new mailbox"
        )]
        no_grant: bool,
    },
    SetName {
        address: String,
        name: String,
    },
    Remove {
        address: String,
    },
}

#[derive(Subcommand)]
enum KeyCommand {
    List,
    Create {
        name: String,
        #[arg(long = "scope", required = true, value_delimiter = ',')]
        scopes: Vec<String>,
        #[arg(
            long = "identity",
            value_delimiter = ',',
            help = "Mail identity this key may access; required for mail scopes"
        )]
        identities: Vec<String>,
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(
            long,
            help = "Replace the stored local credential with the newly issued token"
        )]
        activate: bool,
        #[arg(
            long,
            conflicts_with = "activate",
            help = "Store the new token in this named credential profile"
        )]
        store_as: Option<String>,
    },
    Device {
        #[arg(long, help = "Mailbox identity for this device key")]
        identity: String,
        #[arg(long, default_value = "ios-lmail")]
        name: String,
        #[arg(long, help = "Store the issued token in this local credential profile")]
        store_as: Option<String>,
    },
    Revoke {
        id: String,
    },
}

#[derive(Args)]
struct PageArgs {
    #[arg(long, default_value_t = 100)]
    limit: u16,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long)]
    all: bool,
    #[arg(long)]
    key_id: Option<String>,
    #[arg(long)]
    action: Option<String>,
}

struct Api {
    endpoint: String,
    profile: String,
    admin_confirmed: bool,
    token: Option<String>,
    client: Client,
}

impl Api {
    fn new(
        endpoint: &str,
        profile: &str,
        authenticated: bool,
        admin_confirmed: bool,
    ) -> Result<Self> {
        let endpoint = normalize_endpoint(endpoint)?;
        let token = if authenticated {
            Some(load_token(&endpoint, profile)?)
        } else {
            None
        };
        let client = Self::client(&endpoint, 45)?;
        Ok(Self {
            endpoint,
            profile: profile.to_owned(),
            admin_confirmed,
            token,
            client,
        })
    }

    fn with_token(endpoint: &str, profile: &str, token: String) -> Result<Self> {
        let mut api = Self::new(endpoint, profile, false, false)?;
        api.token = Some(token);
        Ok(api)
    }

    fn client(endpoint: &str, timeout_seconds: u64) -> Result<Client> {
        Client::builder()
            .timeout(Duration::from_secs(timeout_seconds))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("lmail/", env!("CARGO_PKG_VERSION")))
            .https_only(endpoint.starts_with("https://"))
            .build()
            .context("failed to set up the HTTP client")
    }

    fn request(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Response> {
        self.send(&self.client, method, path, body)
    }

    // External sync batches legitimately exceed the default request timeout.
    fn request_slow(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Response> {
        self.send(&Self::client(&self.endpoint, 320)?, method, path, body)
    }

    fn send(
        &self,
        client: &Client,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Response> {
        let mut request = client.request(method, format!("{}{}", self.endpoint, path));
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if self.admin_confirmed {
            request = request.header("X-Admin-Confirmation", "user-approved");
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .map_err(|error| transport_error(error, &self.endpoint))?;
        if !response.status().is_success() {
            let status = response.status();
            let request_id = response
                .headers()
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let text = response.text().unwrap_or_default();
            return Err(api_error(
                status,
                request_id.as_deref(),
                &text,
                self.token.as_deref(),
            ));
        }
        Ok(response)
    }

    fn json(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        parse_json(self.request(method, path, body)?)
    }

    fn json_slow(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        parse_json(self.request_slow(method, path, body)?)
    }
}

/// The endpoint receives the API key, so it must be HTTPS; plain HTTP is
/// accepted for a local test server only.
fn normalize_endpoint(endpoint: &str) -> Result<String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    let loopback =
        endpoint.starts_with("http://127.0.0.1:") || endpoint.starts_with("http://localhost:");
    if !loopback && !endpoint.starts_with("https://") {
        bail!(
            "invalid endpoint {endpoint:?}: it must start with https:// (plain http:// only for 127.0.0.1 or localhost with a port)"
        );
    }
    let url = reqwest::Url::parse(endpoint)
        .map_err(|error| anyhow!("invalid endpoint {endpoint:?}: {error}"))?;
    if url.host_str().is_none_or(str::is_empty) {
        bail!("invalid endpoint {endpoint:?}: it has no host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("invalid endpoint: it must not contain credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("invalid endpoint {endpoint:?}: it must not contain a query or fragment");
    }
    if url.path() != "/" && !url.path().is_empty() {
        bail!("invalid endpoint {endpoint:?}: it must be an origin without a path");
    }
    Ok(endpoint.to_owned())
}

fn transport_error(error: reqwest::Error, endpoint: &str) -> anyhow::Error {
    let what = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "could not connect"
    } else {
        "failed"
    };
    anyhow::Error::new(error.without_url())
        .context(format!("mail API request to {endpoint} {what}"))
}

/// The error for a non-2xx answer. The server's own message and reason are
/// kept (they say what to do next); a body that is not the API's JSON, such as
/// a gateway's HTML page, is summarized instead of dumped; the API key never
/// appears, even if the server echoes it.
fn api_error(
    status: reqwest::StatusCode,
    request_id: Option<&str>,
    text: &str,
    token: Option<&str>,
) -> anyhow::Error {
    let parsed = serde_json::from_str::<Value>(text).ok();
    let message = match parsed
        .as_ref()
        .and_then(|value| value.get("error")?.as_str())
    {
        Some(message) => message.to_owned(),
        None => {
            let plain = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if plain.is_empty() {
                String::new()
            } else if plain.starts_with('<') {
                format!(
                    "the server answered with a non-JSON page ({} bytes)",
                    text.len()
                )
            } else if plain.chars().count() > 300 {
                format!("{}…", plain.chars().take(300).collect::<String>())
            } else {
                plain
            }
        }
    };
    // Without the reason the message alone ("Domain cannot be managed") is a
    // dead end.
    let reason = parsed
        .as_ref()
        .and_then(|value| value.get("details")?.get("reason")?.as_str())
        .map(|reason| format!(": {reason}"))
        .unwrap_or_default();
    let mut line = format!("API {status}");
    if !message.is_empty() || !reason.is_empty() {
        line.push_str(&format!(": {message}{reason}"));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        line.push_str(
            "; the API key is missing, invalid, expired or revoked (run `lmail login` or check LMAIL_API_KEY)",
        );
    }
    if let Some(request_id) = request_id {
        line.push_str(&format!(" (request {request_id})"));
    }
    anyhow!(sanitize_terminal_text(&redact(&line, token)))
}

fn sanitize_terminal_text(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch == '\t' {
                ' '
            } else if ch.is_control()
                || ('\u{007f}'..='\u{009f}').contains(&ch)
                || ('\u{202a}'..='\u{202e}').contains(&ch)
                || ('\u{2066}'..='\u{2069}').contains(&ch)
            {
                '\u{fffd}'
            } else {
                ch
            }
        })
        .collect()
}

fn escape_json_terminal_hazards(json_text: &str) -> String {
    let mut out = String::with_capacity(json_text.len());
    for ch in json_text.chars() {
        if ('\u{007f}'..='\u{009f}').contains(&ch)
            || ('\u{202a}'..='\u{202e}').contains(&ch)
            || ('\u{2066}'..='\u{2069}').contains(&ch)
        {
            out.push_str(&format!("\\u{:04x}", ch as u32));
        } else {
            out.push(ch);
        }
    }
    out
}

fn redact(text: &str, token: Option<&str>) -> String {
    match token {
        Some(token) if !token.is_empty() => text.replace(token, "<redacted>"),
        _ => text.to_owned(),
    }
}

/// A 2xx answer must be JSON. The body is never quoted in the error: a
/// truncated key-creation answer could carry a token.
fn parse_json(response: Response) -> Result<Value> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("none")
        .to_owned();
    let bytes = response
        .bytes()
        .context("failed to read the mail API response")?;
    parse_json_body(status, &content_type, &bytes)
}

fn parse_json_body(status: reqwest::StatusCode, content_type: &str, bytes: &[u8]) -> Result<Value> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        bail!(
            "invalid response from the mail API: {status} with an empty body where JSON was expected"
        );
    }
    serde_json::from_slice(bytes).map_err(|error| {
        anyhow!(
            "invalid response from the mail API: {status} with a body that is not valid JSON ({} bytes, content type {content_type}): {error}",
            bytes.len()
        )
    })
}

/// Ids go into the URL path; encoded, an id can never reach another route.
fn segment(id: &str) -> std::borrow::Cow<'_, str> {
    urlencoding::encode(id)
}

fn parse_daily_cap(value: &str) -> Result<f64, String> {
    match value.parse::<f64>() {
        Ok(cap) if cap.is_finite() && cap >= 0.0 => Ok(cap),
        _ => Err("expected an amount in USD of 0 or more, e.g. 0.25".to_owned()),
    }
}

fn parse_confidence(value: &str) -> Result<f64, String> {
    match value.parse::<f64>() {
        Ok(confidence) if (0.5..=1.0).contains(&confidence) => Ok(confidence),
        _ => Err("expected a number from 0.5 to 1".to_owned()),
    }
}

fn main() {
    if let Err(error) = run() {
        // `lmail … | head` closing the pipe is not a failure.
        if error
            .downcast_ref::<io::Error>()
            .is_some_and(|error| error.kind() == io::ErrorKind::BrokenPipe)
        {
            return;
        }
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let endpoint = load_endpoint(cli.endpoint.as_deref(), &cli.profile)?;
    match cli.command {
        Command::Health => print_value(
            &Api::new(&endpoint, &cli.profile, false, cli.confirm_admin)?.json(
                Method::GET,
                "/health",
                None,
            )?,
            cli.json,
        ),
        Command::Login => login(&endpoint, &cli.profile, cli.json),
        Command::Logout => logout(&endpoint, &cli.profile, cli.json),
        Command::Doctor(args) => {
            let api = Api::new(&endpoint, &cli.profile, true, cli.confirm_admin)?;
            let value = execute_doctor(&api, args)?;
            print_value(&value, cli.json)?;
            if !value
                .get("healthy")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                bail!("doctor found unhealthy checks");
            }
            Ok(())
        }
        Command::Deliverability(args) => {
            let api = Api::new(&endpoint, &cli.profile, true, cli.confirm_admin)?;
            let mut value = api.json(
                Method::GET,
                &format!("/v1/deliverability?hours={}", args.hours),
                None,
            )?;
            validate_public_mta_sts(&api.client, &mut value);
            print_value(&value, cli.json)?;
            if !value
                .get("healthy")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                bail!("deliverability found unhealthy checks");
            }
            Ok(())
        }
        Command::Mail(MailCommand::Watch(args)) => {
            let api = Api::new(&endpoint, &cli.profile, true, cli.confirm_admin)?;
            watch_mailbox(&api, args, cli.json)
        }
        Command::External(command) => {
            let api = Api::new(&endpoint, &cli.profile, true, cli.confirm_admin)?;
            execute_external(&api, command, cli.json)
        }
        command => {
            let administrative = is_administrative(&command);
            if administrative && !cli.confirm_admin {
                bail!(
                    "this changes the mail system itself; run the same command again with --confirm-admin once the owner has approved it"
                );
            }
            let profile = if administrative {
                admin_profile(&endpoint, &cli.profile)
            } else {
                cli.profile.clone()
            };
            let api = Api::new(&endpoint, &profile, true, cli.confirm_admin)?;
            let value = execute_authenticated(&api, command)?;
            print_value(&value, cli.json)
        }
    }
}

fn valid_mta_sts_policy(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    let max_age_valid = lower.lines().find_map(|line| {
        line.trim()
            .strip_prefix("max_age:")?
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|value| (1..=31_557_600).contains(value))
    });
    lower.lines().any(|line| line.trim() == "version: stsv1")
        && lower.lines().any(|line| line.trim() == "mode: enforce")
        && [
            "route1.mx.cloudflare.net",
            "route2.mx.cloudflare.net",
            "route3.mx.cloudflare.net",
        ]
        .iter()
        .all(|host| {
            lower
                .lines()
                .any(|line| line.trim() == format!("mx: {host}"))
        })
        && max_age_valid.is_some()
}

fn safe_mta_sts_policy_url(raw: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(raw).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !host.starts_with("mta-sts.")
        || !host["mta-sts.".len()..].contains('.')
        || url.path() != "/.well-known/mta-sts.txt"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url)
}

fn validate_public_mta_sts(client: &Client, report: &mut Value) {
    let mut all_ok = true;
    let policy_urls = report
        .pointer("/checks/domains")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|domain| {
            domain
                .pointer("/mtaSts/policyUrl")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    let public_checks = thread::scope(|scope| {
        policy_urls
            .iter()
            .map(|url| {
                scope.spawn(move || {
                    url.as_deref()
                        .and_then(safe_mta_sts_policy_url)
                        .and_then(|url| {
                            client.get(url).timeout(Duration::from_secs(10)).send().ok()
                        })
                        .filter(|response| response.status().is_success())
                        .and_then(|response| {
                            let mut body = String::new();
                            response
                                .take(64 * 1024 + 1)
                                .read_to_string(&mut body)
                                .ok()
                                .filter(|&bytes| bytes <= 64 * 1024)
                                .map(|_| body)
                        })
                        .is_some_and(|body| valid_mta_sts_policy(&body))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap_or(false))
            .collect::<Vec<_>>()
    });
    if let Some(domains) = report
        .pointer_mut("/checks/domains")
        .and_then(Value::as_array_mut)
    {
        for (domain, public_ok) in domains.iter_mut().zip(public_checks) {
            if let Some(checks) = domain.get_mut("checks").and_then(Value::as_object_mut) {
                checks.insert("mtaStsHttps".to_owned(), Value::Bool(public_ok));
            }
            let domain_ok = domain.get("ok").and_then(Value::as_bool).unwrap_or(false) && public_ok;
            if let Some(object) = domain.as_object_mut() {
                object.insert("ok".to_owned(), Value::Bool(domain_ok));
            }
            all_ok &= domain_ok;
        }
    }
    let server_healthy = report
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let healthy = server_healthy && all_ok;
    if let Some(object) = report.as_object_mut() {
        object.insert("healthy".to_owned(), Value::Bool(healthy));
        if !healthy {
            object.insert("status".to_owned(), Value::String("unhealthy".to_owned()));
        }
    }
}

fn execute_authenticated(api: &Api, command: Command) -> Result<Value> {
    match command {
        Command::Whoami => api.json(Method::GET, "/v1/whoami", None),
        Command::Summary => api.json(Method::GET, "/v1/summary", None),
        Command::Mail(command) => execute_mail(api, command),
        Command::Draft(command) => execute_draft(api, command),
        Command::Contact(command) => execute_contact(api, command),
        Command::Address(command) => match command {
            AddressCommand::List => api.json(Method::GET, "/v1/addresses", None),
            AddressCommand::Add {
                address,
                name,
                mut grant_keys,
                no_grant,
            } => {
                // The mailbox is meant to be used right away: unless told
                // otherwise, the everyday key gets access to it.
                if !no_grant
                    && let Some(key_id) = everyday_key_id(&api.endpoint)
                    && !grant_keys.contains(&key_id)
                {
                    grant_keys.push(key_id);
                }
                let mut created = api.json(
                    Method::POST,
                    "/v1/addresses",
                    Some(&json!({ "address": address, "displayName": name, "grantKeyIds": grant_keys })),
                )?;
                if let Some(object) = created.as_object_mut() {
                    object.insert(
                        "next".to_owned(),
                        json!([
                            format!("lmail mail list --identity {address}"),
                            format!("lmail mail watch --identity {address}"),
                        ]),
                    );
                }
                Ok(created)
            }
            AddressCommand::SetName { address, name } => api.json(
                Method::PATCH,
                &format!("/v1/addresses/{}", urlencoding::encode(&address)),
                Some(&json!({ "displayName": name })),
            ),
            AddressCommand::Remove { address } => api.json(
                Method::DELETE,
                &format!("/v1/addresses/{}", urlencoding::encode(&address)),
                None,
            ),
        },
        Command::Key(command) => execute_key(api, command),
        Command::Autopilot(command) => execute_autopilot(api, command),
        Command::Audit(args) => collect_pages(
            api,
            "/v1/audit",
            "events",
            args.limit,
            args.cursor,
            args.all,
            &[("keyId", args.key_id), ("action", args.action)],
        ),
        Command::Health
        | Command::Doctor(_)
        | Command::Deliverability(_)
        | Command::Login
        | Command::Logout
        | Command::External(_) => unreachable!(),
    }
}

fn execute_autopilot(api: &Api, command: AutopilotCommand) -> Result<Value> {
    let settings = |body: Value| api.json(Method::PATCH, "/v1/autopilot", Some(&body));
    match command {
        AutopilotCommand::Status => api.json(Method::GET, "/v1/autopilot", None),
        AutopilotCommand::Pause => settings(json!({ "enabled": false })),
        AutopilotCommand::Resume => settings(json!({ "enabled": true })),
        AutopilotCommand::Set(args) => {
            let mut body = Map::new();
            if let Some(drafts) = args.drafts {
                body.insert("drafts".into(), json!(matches!(drafts, Toggle::On)));
            }
            if let Some(brief) = args.brief {
                body.insert("brief".into(), json!(matches!(brief, Toggle::On)));
            }
            if let Some(cap) = args.daily_cap {
                body.insert("dailyCapUsd".into(), json!(cap));
            }
            if body.is_empty() {
                bail!("nothing to set: pass --drafts, --brief or --daily-cap");
            }
            settings(Value::Object(body))
        }
        AutopilotCommand::Rule(rule) => match rule {
            RuleCommand::List => {
                let status = api.json(Method::GET, "/v1/autopilot", None)?;
                Ok(json!({ "rules": status.get("rules").cloned().unwrap_or(Value::Null) }))
            }
            RuleCommand::Add(args) => {
                let mut body = Map::new();
                body.insert("category".into(), json!(value_name(args.category)));
                body.insert("action".into(), json!(value_name(args.action)));
                if let Some(identity) = args.identity {
                    body.insert("identity".into(), json!(identity));
                }
                if let Some(sender) = args.sender {
                    body.insert("senderMatch".into(), json!(sender));
                }
                if let Some(urgency) = args.max_urgency {
                    body.insert("maxUrgency".into(), json!(urgency));
                }
                if let Some(confidence) = args.min_confidence {
                    body.insert("minConfidence".into(), json!(confidence));
                }
                api.json(
                    Method::POST,
                    "/v1/autopilot/rules",
                    Some(&Value::Object(body)),
                )
            }
            RuleCommand::Enable { id } => api.json(
                Method::PATCH,
                &format!("/v1/autopilot/rules/{}", urlencoding::encode(&id)),
                Some(&json!({ "enabled": true })),
            ),
            RuleCommand::Disable { id } => api.json(
                Method::PATCH,
                &format!("/v1/autopilot/rules/{}", urlencoding::encode(&id)),
                Some(&json!({ "enabled": false })),
            ),
            RuleCommand::Remove { id } => api.json(
                Method::DELETE,
                &format!("/v1/autopilot/rules/{}", urlencoding::encode(&id)),
                None,
            ),
        },
        AutopilotCommand::Log(args) => {
            let mut path = format!("/v1/autopilot/actions?limit={}", args.limit);
            if let Some(identity) = args.identity {
                path.push_str(&format!("&identity={}", urlencoding::encode(&identity)));
            }
            api.json(Method::GET, &path, None)
        }
        AutopilotCommand::Undo { id } => api.json(
            Method::POST,
            &format!("/v1/autopilot/actions/{}/undo", urlencoding::encode(&id)),
            None,
        ),
        AutopilotCommand::Draft { id } => api.json(
            Method::POST,
            &format!("/v1/autopilot/draft/{}", urlencoding::encode(&id)),
            None,
        ),
        AutopilotCommand::Brief => api.json(Method::POST, "/v1/autopilot/brief", None),
        AutopilotCommand::Sweep => api.json(Method::POST, "/v1/autopilot/sweep", None),
    }
}

fn execute_external(api: &Api, command: ExternalCommand, compact: bool) -> Result<()> {
    match command {
        ExternalCommand::Status => print_value(
            &api.json(Method::GET, "/v1/external/status", None)?,
            compact,
        ),
        ExternalCommand::Sync(args) => {
            let mut rounds = 0usize;
            loop {
                rounds += 1;
                let mut body = Map::new();
                if let Some(identity) = &args.identity {
                    body.insert("identity".into(), Value::String(identity.clone()));
                }
                body.insert("maxMessages".into(), Value::from(args.max_messages));
                let report = api.json_slow(
                    Method::POST,
                    "/v1/external/sync",
                    Some(&Value::Object(body)),
                )?;
                let done = report.get("done").and_then(Value::as_bool).unwrap_or(false);
                let synced = report
                    .get("syncedMessages")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let skipped = report
                    .get("skippedMessages")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if args.full && !compact {
                    eprintln!("batch {rounds}: {synced} synced, {skipped} skipped, done={done}");
                }
                if !args.full || done || rounds >= 200 {
                    return print_value(&report, compact);
                }
                if synced == 0 && skipped == 0 {
                    print_value(&report, compact)?;
                    bail!("external sync is not making progress; inspect the report above");
                }
            }
        }
    }
}

fn execute_contact(api: &Api, command: ContactCommand) -> Result<Value> {
    match command {
        ContactCommand::List(args) => {
            let mut query = vec![("limit", args.limit.to_string())];
            if let Some(identity) = args.identity {
                query.push(("identity", identity));
            }
            if let Some(search) = args.query {
                query.push(("query", search));
            }
            let query = query
                .into_iter()
                .map(|(name, value)| format!("{}={}", urlencoding::encode(name), urlencoding::encode(&value)))
                .collect::<Vec<_>>()
                .join("&");
            api.json(Method::GET, &format!("/v1/contacts?{query}"), None)
        }
        ContactCommand::Add {
            address,
            identity,
            name,
        } => api.json(
            Method::POST,
            "/v1/contacts",
            Some(&json!({ "identity": identity, "address": address, "displayName": name.unwrap_or_default() })),
        ),
        ContactCommand::SetName {
            address,
            name,
            identity,
        } => api.json(
            Method::PATCH,
            &format!("/v1/contacts/{}", urlencoding::encode(&address)),
            Some(&json!({ "identity": identity, "displayName": name })),
        ),
        ContactCommand::Remove { address, identity } => api.json(
            Method::DELETE,
            &format!(
                "/v1/contacts/{}?identity={}",
                urlencoding::encode(&address),
                urlencoding::encode(&identity)
            ),
            None,
        ),
    }
}

fn execute_doctor(api: &Api, args: DoctorArgs) -> Result<Value> {
    let mut report = api.json(Method::GET, "/v1/doctor", None)?;
    if !args.loopback {
        return Ok(report);
    }

    let addresses = if args.address.is_empty() {
        report
            .pointer("/checks/routing")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|check| check.get("address").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        args.address
    };
    if addresses.is_empty() {
        bail!("doctor found no addresses to test");
    }
    let recipient = report
        .get("owner")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("doctor response is missing the owner address"))?
        .to_owned();

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis();
    let prefix = format!("lmail doctor {nonce}");
    let mut results = Vec::with_capacity(addresses.len());
    for (index, address) in addresses.iter().enumerate() {
        let subject = format!("{prefix} {index}");
        let send_result = api.json(
            Method::POST,
            "/v1/messages/send",
            Some(&json!({
                "from": address,
                "to": [&recipient],
                "subject": subject,
                "text": "Automated lmail end-to-end delivery check.",
                "idempotencyKey": Uuid::new_v4().to_string()
            })),
        );
        match send_result {
            Ok(_) => results.push(json!({
                "address": address, "recipient": recipient, "subject": subject, "sent": true, "received": false
            })),
            Err(error) => results.push(json!({
                "address": address, "recipient": recipient, "subject": subject, "sent": false, "received": false,
                "error": format!("{error:#}")
            })),
        }
    }

    let deadline = Instant::now() + Duration::from_secs(args.timeout);
    while results
        .iter()
        .any(|result| result.get("sent") == Some(&Value::Bool(true)))
    {
        let path = format!(
            "/v1/messages?folder=inbox&query={}&limit=100",
            urlencoding::encode(&prefix)
        );
        let messages = api.json(Method::GET, &path, None)?;
        let subjects = messages
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|message| message.get("subject").and_then(Value::as_str))
            .collect::<Vec<_>>();
        for result in &mut results {
            if result.get("sent") != Some(&Value::Bool(true)) {
                continue;
            }
            let expected = result
                .get("subject")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if subjects.contains(&expected) {
                result["received"] = Value::Bool(true);
            }
        }
        if results
            .iter()
            .filter(|result| result.get("sent") == Some(&Value::Bool(true)))
            .all(|result| result.get("received") == Some(&Value::Bool(true)))
            || Instant::now() >= deadline
        {
            break;
        }
        thread::sleep(Duration::from_secs(2));
    }

    let received = results
        .iter()
        .filter(|result| result.get("received") == Some(&Value::Bool(true)))
        .count();
    let sent = results
        .iter()
        .filter(|result| result.get("sent") == Some(&Value::Bool(true)))
        .count();
    let loopback_ok = received == results.len();
    report["loopback"] = json!({
        "ok": loopback_ok,
        "attempted": results.len(),
        "sent": sent,
        "received": received,
        "timeoutSeconds": args.timeout,
        "results": results
    });
    let static_ok = report
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    report["healthy"] = Value::Bool(static_ok && loopback_ok);
    Ok(report)
}

fn execute_mail(api: &Api, command: MailCommand) -> Result<Value> {
    match command {
        MailCommand::List(args) => collect_pages(
            api,
            "/v1/messages",
            "messages",
            args.limit,
            args.cursor,
            args.all,
            &[
                ("folder", Some(args.folder.as_str().to_owned())),
                ("query", args.query),
                ("identity", args.identity),
            ],
        ),
        MailCommand::Watch(_) => unreachable!("watch is a streaming command"),
        MailCommand::Show { id } => {
            api.json(Method::GET, &format!("/v1/messages/{}", segment(&id)), None)
        }
        MailCommand::Send(args) => {
            let text = read_body(args.body, args.body_file)?;
            let html = args
                .html_file
                .map(fs::read_to_string)
                .transpose()
                .context("failed to read HTML file")?;
            let attachments = args
                .attach
                .iter()
                .map(attachment_json)
                .collect::<Result<Vec<_>>>()?;
            api.json(Method::POST, "/v1/messages/send", Some(&json!({ "from": args.from, "to": args.to, "cc": args.cc,
                "bcc": args.bcc, "subject": args.subject, "text": text, "html": html, "replyToMessageId": args.reply_to,
                "attachments": attachments, "idempotencyKey": args.idempotency_key.unwrap_or_else(|| Uuid::new_v4().to_string()) })))
        }
        MailCommand::SendStatus { idempotency_key } => api.json(
            Method::GET,
            &format!("/v1/send-requests/{}", segment(&idempotency_key)),
            None,
        ),
        MailCommand::Update(args) => {
            let mut body = Map::new();
            if args.read {
                body.insert("unread".into(), Value::Bool(false));
            }
            if args.unread {
                body.insert("unread".into(), Value::Bool(true));
            }
            if args.star {
                body.insert("starred".into(), Value::Bool(true));
            }
            if args.unstar {
                body.insert("starred".into(), Value::Bool(false));
            }
            if args.spam {
                body.insert("spam".into(), Value::Bool(true));
            }
            if args.not_spam {
                body.insert("spam".into(), Value::Bool(false));
            }
            if let Some(folder) = args.folder {
                body.insert("folder".into(), Value::String(folder.as_str().into()));
            }
            if body.is_empty() {
                bail!("provide at least one update flag");
            }
            api.json(
                Method::PATCH,
                &format!("/v1/messages/{}", segment(&args.id)),
                Some(&Value::Object(body)),
            )
        }
        MailCommand::Raw { id, output } => {
            download(api, &format!("/v1/messages/{}/raw", segment(&id)), &output)
        }
        MailCommand::Attachment { id, output } => {
            download(api, &format!("/v1/attachments/{}", segment(&id)), &output)
        }
    }
}

fn watch_mailbox(api: &Api, args: MailWatchArgs, compact: bool) -> Result<()> {
    let identity = args.identity.as_str();
    let mut revision = mailbox_state(api, Some(identity), None, 0)?
        .get("revision")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing mailbox revision"))?
        .to_owned();
    print_mailbox_snapshot(api, &args, &revision, compact)?;

    loop {
        let state = mailbox_state(api, Some(identity), Some(&revision), args.wait_seconds)?;
        let next = state
            .get("revision")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("missing mailbox revision"))?
            .to_owned();
        if next != revision {
            if args.full_snapshots {
                revision = next;
                print_mailbox_snapshot(api, &args, &revision, compact)?;
            } else {
                revision = print_mailbox_deltas(api, &args, &revision, compact)?;
            }
        }
    }
}

fn print_mailbox_deltas(
    api: &Api,
    args: &MailWatchArgs,
    since: &str,
    compact: bool,
) -> Result<String> {
    let mut cursor: Option<String> = None;
    loop {
        let mut pairs = vec![
            ("identity", args.identity.clone()),
            ("since", since.to_owned()),
            ("limit", "250".to_owned()),
        ];
        if let Some(value) = &cursor {
            pairs.push(("cursor", value.clone()));
        }
        let query = encode_query(pairs);
        let delta = api.json(Method::GET, &format!("/v1/mailbox-delta?{query}"), None)?;
        let revision = delta
            .get("revision")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("missing mailbox delta revision"))?
            .to_owned();
        if delta
            .get("resetRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            print_value(&json!({ "type": "reset", "delta": delta }), compact)?;
            print_mailbox_snapshot(api, args, &revision, compact)?;
            return Ok(revision);
        }
        print_value(&json!({ "type": "delta", "delta": delta }), compact)?;
        io::stdout()
            .flush()
            .context("failed to flush mailbox delta")?;
        if !delta
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(revision);
        }
        cursor = Some(
            delta
                .get("nextCursor")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("mailbox delta page omitted nextCursor"))?
                .to_owned(),
        );
    }
}

fn encode_query(pairs: Vec<(&str, String)>) -> String {
    pairs
        .into_iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                urlencoding::encode(name),
                urlencoding::encode(&value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn mailbox_state(
    api: &Api,
    identity: Option<&str>,
    after: Option<&str>,
    wait_seconds: u8,
) -> Result<Value> {
    let mut pairs = vec![("wait", wait_seconds.to_string())];
    if let Some(identity) = identity {
        pairs.push(("identity", identity.to_owned()));
    }
    if let Some(after) = after {
        pairs.push(("after", after.to_owned()));
    }
    let query = pairs
        .into_iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                urlencoding::encode(name),
                urlencoding::encode(&value)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    api.json(Method::GET, &format!("/v1/mailbox-state?{query}"), None)
}

fn print_mailbox_snapshot(
    api: &Api,
    args: &MailWatchArgs,
    revision: &str,
    compact: bool,
) -> Result<()> {
    let mut pairs = vec![
        ("folder", args.folder.as_str().to_owned()),
        ("limit", args.limit.min(100).to_string()),
    ];
    pairs.push(("identity", args.identity.clone()));
    if let Some(query) = &args.query {
        pairs.push(("query", query.clone()));
    }
    let query = pairs
        .into_iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                urlencoding::encode(name),
                urlencoding::encode(&value)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    let mailbox = api.json(Method::GET, &format!("/v1/messages?{query}"), None)?;
    print_value(
        &json!({ "revision": revision, "mailbox": mailbox }),
        compact,
    )?;
    io::stdout()
        .flush()
        .context("failed to flush mailbox update")
}

fn execute_draft(api: &Api, command: DraftCommand) -> Result<Value> {
    match command {
        DraftCommand::List => api.json(Method::GET, "/v1/drafts", None),
        DraftCommand::Save(args) => api.json(Method::PUT, "/v1/drafts", Some(&json!({ "id": args.id, "from": args.from, "replyToMessageId": args.reply_to,
            "to": args.to, "cc": args.cc, "bcc": args.bcc, "subject": args.subject, "text": read_body(args.body, args.body_file)? }))),
        DraftCommand::Delete { id } => api.json(Method::DELETE, &format!("/v1/drafts/{}", segment(&id)), None),
    }
}

fn execute_key(api: &Api, command: KeyCommand) -> Result<Value> {
    match command {
        KeyCommand::List => api.json(Method::GET, "/v1/keys", None),
        KeyCommand::Create {
            name,
            scopes,
            identities,
            expires_at,
            activate,
            store_as,
        } => {
            let identities = if identities.is_empty() {
                Value::Null
            } else {
                json!(identities)
            };
            let value = api.json(
                Method::POST,
                "/v1/keys",
                Some(&json!({ "name": name, "scopes": scopes, "identities": identities, "expiresAt": expires_at })),
            )?;
            if activate || store_as.is_some() {
                let token = value
                    .get("token")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("API did not return a token"))?;
                save_token(
                    &api.endpoint,
                    store_as.as_deref().unwrap_or(&api.profile),
                    token,
                )?;
            }
            if activate || store_as.is_some() {
                let mut redacted = value;
                redacted["token"] = Value::String("<stored-locally>".into());
                Ok(redacted)
            } else {
                Ok(value)
            }
        }
        KeyCommand::Device {
            identity,
            name,
            store_as,
        } => {
            let mut value = api.json(
                Method::POST,
                "/v1/keys/device",
                Some(&json!({ "name": name, "identity": identity })),
            )?;
            let token = value
                .get("token")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("API did not return a token"))?;
            if let Some(profile) = store_as {
                save_token(&api.endpoint, &profile, token)?;
                value["token"] = Value::String("<stored-locally>".into());
                value["storedAs"] = Value::String(profile);
            }
            Ok(value)
        }
        KeyCommand::Revoke { id } => {
            api.json(Method::DELETE, &format!("/v1/keys/{}", segment(&id)), None)
        }
    }
}

fn collect_pages(
    api: &Api,
    base: &str,
    field: &str,
    limit: u16,
    initial_cursor: Option<String>,
    all: bool,
    filters: &[(&str, Option<String>)],
) -> Result<Value> {
    let mut cursor = initial_cursor;
    let mut collected = Vec::new();
    loop {
        let mut pairs = vec![("limit", limit.to_string())];
        if let Some(value) = &cursor {
            pairs.push(("cursor", value.clone()));
        }
        for (name, value) in filters {
            if let Some(value) = value {
                pairs.push((name, value.clone()));
            }
        }
        let query = pairs
            .into_iter()
            .map(|(name, value)| {
                format!(
                    "{}={}",
                    urlencoding::encode(name),
                    urlencoding::encode(&value)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        let page = api.json(Method::GET, &format!("{base}?{query}"), None)?;
        let items = page
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("missing {field} array"))?;
        if !all {
            return Ok(page);
        }
        collected.extend(items);
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            let mut result = Map::new();
            result.insert(field.to_owned(), Value::Array(collected));
            result.insert("nextCursor".to_owned(), Value::Null);
            return Ok(Value::Object(result));
        }
    }
}

fn login(endpoint: &str, profile: &str, compact: bool) -> Result<()> {
    let token = match std::env::var("LMAIL_API_KEY") {
        Ok(token) => token,
        Err(_) => rpassword::prompt_password("API key: ").context("failed to read the API key")?,
    };
    let token = token.trim().to_owned();
    if token.len() < 100 || !token.starts_with("lm_live_") {
        bail!("invalid lmail API key format: expected lm_live_… with at least 100 characters");
    }
    let api = Api::with_token(endpoint, profile, token.clone())?;
    let whoami = api
        .json(Method::GET, "/v1/whoami", None)
        .context("key verification failed")?;
    save_token(api.endpoint.as_str(), profile, &token)?;
    print_value(
        &json!({ "stored": true, "endpoint": api.endpoint, "identity": whoami }),
        compact,
    )
}

fn logout(endpoint: &str, profile: &str, compact: bool) -> Result<()> {
    let endpoint = normalize_endpoint(endpoint)?;
    let endpoint = endpoint.as_str();
    let mut store = read_credential_store()?;
    remove_token_and_endpoint(&mut store, endpoint, profile);
    write_credential_store(&store)?;
    print_value(
        &json!({ "removed": true, "endpoint": endpoint.trim_end_matches('/') }),
        compact,
    )
}

/// Commands that change addresses or keys. They need the administrator key
/// and the explicit confirmation flag.
fn is_administrative(command: &Command) -> bool {
    match command {
        Command::Address(address) => !matches!(address, AddressCommand::List),
        Command::Key(key) => !matches!(key, KeyCommand::List),
        _ => false,
    }
}

/// The profile an administrative command runs under: the one named on the
/// command line, else the stored `admin` profile when there is one, so the
/// everyday key (which cannot administer) is never the reason a command fails.
fn admin_profile(endpoint: &str, requested: &str) -> String {
    if requested != "default" || std::env::var_os("LMAIL_API_KEY").is_some() {
        return requested.to_owned();
    }
    let has_admin = read_credential_store()
        .map(|store| store.contains_key(&credential_key(endpoint, "admin")))
        .unwrap_or(false);
    if has_admin {
        "admin".to_owned()
    } else {
        requested.to_owned()
    }
}

/// The id of the default profile's key when that key is limited to a list of
/// mailboxes, so a new mailbox can be added to the list as it is created.
fn everyday_key_id(endpoint: &str) -> Option<String> {
    let api = Api::new(endpoint, "default", true, false).ok()?;
    let whoami = api.json(Method::GET, "/v1/whoami", None).ok()?;
    let principal = whoami.get("principal")?;
    if principal.get("allowedIdentities")?.is_null() {
        return None;
    }
    principal.get("keyId")?.as_str().map(str::to_owned)
}

fn load_token(endpoint: &str, profile: &str) -> Result<String> {
    let from_env = std::env::var_os("LMAIL_API_KEY");
    if from_env.is_some() {
        return resolve_token(from_env, &Map::new(), endpoint, profile);
    }
    resolve_token(None, &read_credential_store()?, endpoint, profile)
}

/// The key for a request: LMAIL_API_KEY when it is set, else the stored one.
/// A key that cannot work is refused here, with words, before any request.
fn resolve_token(
    from_env: Option<std::ffi::OsString>,
    store: &Map<String, Value>,
    endpoint: &str,
    profile: &str,
) -> Result<String> {
    let (token, source) = match from_env {
        Some(value) => (
            value
                .into_string()
                .map_err(|_| anyhow!("LMAIL_API_KEY is not valid UTF-8"))?,
            "LMAIL_API_KEY".to_owned(),
        ),
        None => match store.get(&credential_key(endpoint, profile)) {
            Some(Value::String(token)) => (
                token.clone(),
                format!("the stored key for profile {profile}"),
            ),
            Some(_) => bail!(
                "the stored credential for profile {profile} is not a string; run `lmail login` again"
            ),
            None => bail!(
                "no API key configured for profile {profile} at {endpoint}; run `lmail login` or set LMAIL_API_KEY"
            ),
        },
    };
    let token = token.trim();
    if token.is_empty() {
        bail!("{source} is empty; run `lmail login` or set LMAIL_API_KEY");
    }
    if token
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        bail!("{source} contains whitespace or control characters; it cannot be an API key");
    }
    Ok(token.to_owned())
}

fn load_endpoint(cli_endpoint: Option<&str>, profile: &str) -> Result<String> {
    let env_endpoint = std::env::var_os("LMAIL_ENDPOINT");
    if cli_endpoint.is_some() || env_endpoint.is_some() {
        return resolve_endpoint(cli_endpoint, env_endpoint.as_deref(), &Map::new(), profile);
    }
    resolve_endpoint(None, None, &read_credential_store()?, profile)
}

/// Resolves the server endpoint with priority:
/// explicit `--endpoint` flag > `LMAIL_ENDPOINT` env var > endpoint saved for the profile.
fn resolve_endpoint(
    cli_endpoint: Option<&str>,
    env_endpoint: Option<&std::ffi::OsStr>,
    store: &Map<String, Value>,
    profile: &str,
) -> Result<String> {
    if let Some(endpoint) = cli_endpoint {
        return normalize_endpoint(endpoint);
    }
    if let Some(raw) = env_endpoint {
        let value = raw
            .to_str()
            .ok_or_else(|| anyhow!("LMAIL_ENDPOINT is not valid UTF-8"))?;
        if !value.trim().is_empty() {
            return normalize_endpoint(value);
        }
    }
    if let Some(endpoint) = saved_endpoint(store, profile) {
        return normalize_endpoint(&endpoint);
    }
    bail!(
        "no endpoint configured for profile {profile}; pass --endpoint https://mail.example.com, set LMAIL_ENDPOINT, or run `lmail login --endpoint https://mail.example.com`"
    )
}

fn saved_endpoint(store: &Map<String, Value>, profile: &str) -> Option<String> {
    if let Some(endpoint) = store
        .get("endpoints")
        .and_then(Value::as_object)
        .and_then(|endpoints| endpoints.get(profile))
        .and_then(Value::as_str)
    {
        return Some(endpoint.to_owned());
    }
    // Backwards-compatible fallback for stores saved before profile endpoints were tracked:
    // if there is a single credential entry for this profile, reuse its endpoint.
    let suffix = format!("#{profile}");
    let mut matches = store.keys().filter_map(|key| {
        if !(key.starts_with("https://") || key.starts_with("http://")) {
            return None;
        }
        if profile == "default" {
            (!key.contains('#')).then(|| key.clone())
        } else {
            key.strip_suffix(&suffix).map(str::to_owned)
        }
    });
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first)
}

fn save_token(endpoint: &str, profile: &str, token: &str) -> Result<()> {
    let endpoint = normalize_endpoint(endpoint)?;
    let mut store = read_credential_store()?;
    store_token_and_endpoint(&mut store, &endpoint, profile, token);
    write_credential_store(&store)
}

fn store_token_and_endpoint(
    store: &mut Map<String, Value>,
    endpoint: &str,
    profile: &str,
    token: &str,
) {
    let endpoint = endpoint.trim_end_matches('/');
    store.insert(
        credential_key(endpoint, profile),
        Value::String(token.to_owned()),
    );
    let endpoints = match store.get_mut("endpoints") {
        Some(Value::Object(map)) => map,
        _ => {
            store.insert("endpoints".to_owned(), Value::Object(Map::new()));
            store
                .get_mut("endpoints")
                .and_then(Value::as_object_mut)
                .expect("just inserted endpoints object")
        }
    };
    endpoints.insert(profile.to_owned(), Value::String(endpoint.to_owned()));
}

fn remove_token_and_endpoint(store: &mut Map<String, Value>, endpoint: &str, profile: &str) {
    let endpoint = endpoint.trim_end_matches('/');
    store.remove(&credential_key(endpoint, profile));
    if let Some(Value::Object(endpoints)) = store.get_mut("endpoints") {
        if endpoints.get(profile).and_then(Value::as_str) == Some(endpoint) {
            endpoints.remove(profile);
        }
        if endpoints.is_empty() {
            store.remove("endpoints");
        }
    }
}

fn credential_key(endpoint: &str, profile: &str) -> String {
    let endpoint = endpoint.trim_end_matches('/');
    if profile == "default" {
        endpoint.to_owned()
    } else {
        format!("{endpoint}#{profile}")
    }
}

fn credentials_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME is not set"))?;
    Ok(PathBuf::from(home)
        .join(".config")
        .join("lmail")
        .join("credentials.json"))
}

fn read_credential_store() -> Result<Map<String, Value>> {
    let path = credentials_path()?;
    let data = match fs::read_to_string(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    let parsed: Value = serde_json::from_str(&data).map_err(|error| {
        // serde's message has the position only, never the file's content.
        anyhow!(
            "{} is not valid JSON ({error}); fix it or delete it and run `lmail login`",
            path.display()
        )
    })?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => bail!("{} must contain a JSON object", path.display()),
    }
}

// Tokens live in a user-only file (0600 in a 0700 directory) instead of the
// system keychain: equivalent single-user protection without ACL prompts on
// every rebuilt binary.
fn write_credential_store(store: &Map<String, Value>) -> Result<()> {
    let path = credentials_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| anyhow!("credentials path has no parent directory"))?;
    fs::create_dir_all(directory)
        .with_context(|| format!("failed to create {}", directory.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("failed to restrict {}", directory.display()))?;
    }
    let payload = serde_json::to_string_pretty(&Value::Object(store.clone()))?;
    write_private_file_atomic(&path, payload.as_bytes())
}

fn write_private_file_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
    let parent = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    let temp_name = format!(
        ".{}.tmp-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("lmail"),
        Uuid::new_v4()
    );
    let temp_path = parent.join(temp_name);
    let write_result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .with_context(|| format!("failed to create {}", temp_path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write {}", temp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to flush {}", temp_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))
                .with_context(|| format!("failed to restrict {}", temp_path.display()))?;
        }
        fs::rename(&temp_path, target)
            .with_context(|| format!("failed to finalize {}", target.display()))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn read_body(body: Option<String>, body_file: Option<PathBuf>) -> Result<String> {
    if let Some(body) = body {
        return Ok(body);
    }
    if let Some(path) = body_file {
        return fs::read_to_string(path).context("failed to read body file");
    }
    let mut value = String::new();
    io::stdin()
        .read_to_string(&mut value)
        .context("failed to read body from stdin")?;
    Ok(value)
}

fn attachment_json(path: &PathBuf) -> Result<Value> {
    let bytes =
        fs::read(path).with_context(|| format!("failed to read attachment {}", path.display()))?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow!("invalid attachment filename"))?;
    let content_type = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    Ok(json!({ "filename": filename, "contentType": content_type, "data": STANDARD.encode(bytes) }))
}

fn download(api: &Api, path: &str, output: &Path) -> Result<Value> {
    let bytes = api
        .request(Method::GET, path, None)?
        .bytes()
        .context("failed to read the download from the mail API")?;
    write_private_file_atomic(output, &bytes)?;
    Ok(json!({ "saved": true, "path": output, "bytes": bytes.len() }))
}

fn print_value(value: &Value, compact: bool) -> Result<()> {
    let raw = if compact {
        serde_json::to_string(value)?
    } else {
        serde_json::to_string_pretty(value)?
    };
    let text = escape_json_terminal_hazards(&raw);
    let mut out = io::stdout().lock();
    writeln!(out, "{text}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_message_ids_that_start_with_a_hyphen() {
        let cli =
            Cli::try_parse_from(["lmail", "mail", "show", "-Xq3w9"]).expect("show should parse");
        let Command::Mail(MailCommand::Show { id }) = cli.command else {
            panic!("expected show command")
        };
        assert_eq!(id, "-Xq3w9");
        let cli = Cli::try_parse_from(["lmail", "mail", "update", "-Xq3w9", "--read"])
            .expect("update should parse");
        let Command::Mail(MailCommand::Update(args)) = cli.command else {
            panic!("expected update command")
        };
        assert_eq!(args.id, "-Xq3w9");
        assert!(args.read);
    }

    #[test]
    fn parses_autopilot_commands() {
        let cli = Cli::try_parse_from([
            "lmail",
            "autopilot",
            "rule",
            "add",
            "--category",
            "agent",
            "--action",
            "read",
            "--sender",
            "@alerts.example.org",
            "--max-urgency",
            "1",
        ])
        .expect("rule add should parse");
        let Command::Autopilot(AutopilotCommand::Rule(RuleCommand::Add(args))) = cli.command else {
            panic!("expected rule add")
        };
        assert_eq!(value_name(args.category), "agent");
        assert_eq!(value_name(args.action), "read");
        assert_eq!(args.max_urgency, Some(1));
        let cli = Cli::try_parse_from(["lmail", "autopilot", "undo", "-1b2c3d4"])
            .expect("undo should parse");
        assert!(
            matches!(cli.command, Command::Autopilot(AutopilotCommand::Undo { ref id }) if id == "-1b2c3d4")
        );
        assert!(
            Cli::try_parse_from([
                "lmail",
                "autopilot",
                "rule",
                "add",
                "--category",
                "spam",
                "--action",
                "archive"
            ])
            .is_err()
        );
    }

    #[test]
    fn parses_agent_friendly_send_command() {
        let cli = Cli::try_parse_from([
            "lmail",
            "--json",
            "mail",
            "send",
            "--from",
            "user@example.com",
            "--to",
            "one@example.com,two@example.com",
            "--subject",
            "hello",
            "--body",
            "world",
        ])
        .expect("command should parse");
        let Command::Mail(MailCommand::Send(args)) = cli.command else {
            panic!("expected send command")
        };
        assert!(cli.json);
        assert_eq!(args.to, ["one@example.com", "two@example.com"]);
        assert_eq!(args.subject, "hello");
    }

    #[test]
    fn rejects_conflicting_state_flags() {
        assert!(
            Cli::try_parse_from(["lmail", "mail", "update", "message", "--read", "--unread"])
                .is_err()
        );
        assert!(
            Cli::try_parse_from(["lmail", "mail", "update", "message", "--star", "--unstar"])
                .is_err()
        );
    }

    #[test]
    fn defaults_without_hardcoded_endpoint() {
        let cli = Cli::try_parse_from(["lmail", "health"]).expect("health command should parse");
        assert_eq!(cli.endpoint, None);
        assert_eq!(cli.profile, "default");
    }

    #[test]
    fn resolves_endpoint_by_priority() {
        let mut store = Map::new();
        store_token_and_endpoint(
            &mut store,
            "https://saved.example.com/",
            "default",
            "lm_live_saved",
        );

        // Explicit flag wins over env and saved profile.
        assert_eq!(
            resolve_endpoint(
                Some("https://flag.example.com/"),
                Some(std::ffi::OsStr::new("https://env.example.org/")),
                &store,
                "default",
            )
            .unwrap(),
            "https://flag.example.com"
        );

        // LMAIL_ENDPOINT env var wins over saved profile.
        assert_eq!(
            resolve_endpoint(
                None,
                Some(std::ffi::OsStr::new("https://env.example.org/")),
                &store,
                "default",
            )
            .unwrap(),
            "https://env.example.org"
        );

        // Saved profile endpoint is used when neither flag nor env is set.
        assert_eq!(
            resolve_endpoint(None, None, &store, "default").unwrap(),
            "https://saved.example.com"
        );

        // Blank env var falls back to saved profile.
        assert_eq!(
            resolve_endpoint(None, Some(std::ffi::OsStr::new("   ")), &store, "default").unwrap(),
            "https://saved.example.com"
        );

        // Missing endpoint for an unconfigured profile returns a clear error.
        let err = resolve_endpoint(None, None, &Map::new(), "default")
            .unwrap_err()
            .to_string();
        assert!(err.contains("--endpoint"));
        assert!(err.contains("LMAIL_ENDPOINT"));
    }

    #[test]
    fn persists_and_removes_profile_endpoint_with_token() {
        let mut store = Map::new();
        store_token_and_endpoint(
            &mut store,
            "https://mail.example.com/",
            "default",
            "lm_live_default_token",
        );
        store_token_and_endpoint(
            &mut store,
            "https://admin.example.org/",
            "admin",
            "lm_live_admin_token",
        );

        assert_eq!(
            resolve_endpoint(None, None, &store, "default").unwrap(),
            "https://mail.example.com"
        );
        assert_eq!(
            resolve_endpoint(None, None, &store, "admin").unwrap(),
            "https://admin.example.org"
        );
        assert_eq!(
            resolve_token(None, &store, "https://mail.example.com", "default").unwrap(),
            "lm_live_default_token"
        );
        assert_eq!(
            resolve_token(None, &store, "https://admin.example.org", "admin").unwrap(),
            "lm_live_admin_token"
        );

        remove_token_and_endpoint(&mut store, "https://mail.example.com", "default");
        assert!(resolve_endpoint(None, None, &store, "default").is_err());
        assert_eq!(
            resolve_endpoint(None, None, &store, "admin").unwrap(),
            "https://admin.example.org"
        );
    }

    #[test]
    fn falls_back_to_single_legacy_credential_endpoint() {
        let mut store = Map::new();
        store.insert(
            credential_key("https://legacy.example.com", "default"),
            Value::String("lm_live_legacy".to_owned()),
        );
        assert_eq!(
            resolve_endpoint(None, None, &store, "default").unwrap(),
            "https://legacy.example.com"
        );

        // Ambiguous legacy store with two endpoints for the same profile requires explicit config.
        store.insert(
            credential_key("https://other.example.org", "default"),
            Value::String("lm_live_other".to_owned()),
        );
        assert!(resolve_endpoint(None, None, &store, "default").is_err());
    }

    #[test]
    fn accepts_named_credential_profile() {
        let cli = Cli::try_parse_from(["lmail", "--profile", "admin", "whoami"])
            .expect("profile should parse");
        assert_eq!(cli.profile, "admin");
    }

    #[test]
    fn parses_agent_display_name_update() {
        let cli = Cli::try_parse_from([
            "lmail",
            "--profile",
            "admin",
            "--confirm-admin",
            "address",
            "set-name",
            "user@example.com",
            "Alex Example",
        ])
        .expect("display-name update should parse");
        let Command::Address(AddressCommand::SetName { address, name }) = cli.command else {
            panic!("expected address set-name command")
        };
        assert_eq!(address, "user@example.com");
        assert_eq!(name, "Alex Example");
        assert!(cli.confirm_admin);
    }

    #[test]
    fn parses_loopback_doctor_command() {
        let cli = Cli::try_parse_from([
            "lmail",
            "doctor",
            "--loopback",
            "--address",
            "dev@example.com,prod@example.org",
            "--timeout",
            "30",
        ])
        .expect("doctor command should parse");
        let Command::Doctor(args) = cli.command else {
            panic!("expected doctor command")
        };
        assert!(args.loopback);
        assert_eq!(args.address.len(), 2);
        assert_eq!(args.timeout, 30);
    }

    #[test]
    fn parses_deliverability_window() {
        let cli = Cli::try_parse_from(["lmail", "deliverability", "--hours", "72"])
            .expect("deliverability command should parse");
        let Command::Deliverability(args) = cli.command else {
            panic!("expected deliverability command")
        };
        assert_eq!(args.hours, 72);
    }

    #[test]
    fn validates_expected_mta_sts_policy() {
        assert!(valid_mta_sts_policy(
            "version: STSv1\nmode: enforce\nmx: route1.mx.cloudflare.net\nmx: route2.mx.cloudflare.net\nmx: route3.mx.cloudflare.net\nmax_age: 604800\n"
        ));
        assert!(!valid_mta_sts_policy("version: STSv1\nmode: testing\n"));
    }

    #[test]
    fn parses_restricted_device_key_command() {
        let cli = Cli::try_parse_from([
            "lmail",
            "--profile",
            "admin",
            "--confirm-admin",
            "key",
            "device",
            "--identity",
            "user@example.com",
        ])
        .expect("device key command should parse");
        let Command::Key(KeyCommand::Device {
            identity, store_as, ..
        }) = cli.command
        else {
            panic!("expected device key command")
        };
        assert_eq!(identity, "user@example.com");
        assert_eq!(store_as, None);
    }

    #[test]
    fn parses_send_status_command() {
        let cli = Cli::try_parse_from([
            "lmail",
            "mail",
            "send-status",
            "11111111-1111-4111-8111-111111111111",
        ])
        .expect("send-status command should parse");
        let Command::Mail(MailCommand::SendStatus { idempotency_key }) = cli.command else {
            panic!("expected send-status command")
        };
        assert_eq!(idempotency_key, "11111111-1111-4111-8111-111111111111");
    }

    #[test]
    fn parses_network_efficient_mail_watch() {
        let cli = Cli::try_parse_from([
            "lmail",
            "--json",
            "mail",
            "watch",
            "--identity",
            "user@example.com",
            "--folder",
            "inbox",
            "--wait-seconds",
            "25",
        ])
        .expect("mail watch should parse");
        let Command::Mail(MailCommand::Watch(args)) = cli.command else {
            panic!("expected mail watch command")
        };
        assert_eq!(args.identity, "user@example.com");
        assert_eq!(args.wait_seconds, 25);
        assert!(!args.full_snapshots);
        assert!(cli.json);
    }

    #[test]
    fn parses_full_external_sync() {
        let cli = Cli::try_parse_from([
            "lmail",
            "external",
            "sync",
            "--full",
            "--max-messages",
            "100",
        ])
        .expect("external sync should parse");
        let Command::External(ExternalCommand::Sync(args)) = cli.command else {
            panic!("expected external sync command")
        };
        assert!(args.full);
        assert_eq!(args.max_messages, 100);
        assert_eq!(args.identity, None);
    }

    #[test]
    fn parses_ranked_contact_search() {
        let cli = Cli::try_parse_from([
            "lmail",
            "contact",
            "list",
            "--identity",
            "user@example.com",
            "--query",
            "friend",
            "--limit",
            "12",
        ])
        .expect("contact list command should parse");
        let Command::Contact(ContactCommand::List(args)) = cli.command else {
            panic!("expected contact list command")
        };
        assert_eq!(args.identity.as_deref(), Some("user@example.com"));
        assert_eq!(args.query.as_deref(), Some("friend"));
        assert_eq!(args.limit, 12);
    }

    #[test]
    fn parses_contact_name_update() {
        let cli = Cli::try_parse_from([
            "lmail",
            "contact",
            "set-name",
            "friend@example.com",
            "Friendly Person",
            "--identity",
            "user@example.com",
        ])
        .expect("contact update should parse");
        let Command::Contact(ContactCommand::SetName {
            address,
            name,
            identity,
        }) = cli.command
        else {
            panic!("expected contact set-name command")
        };
        assert_eq!(address, "friend@example.com");
        assert_eq!(name, "Friendly Person");
        assert_eq!(identity, "user@example.com");
    }

    #[test]
    fn normalizes_and_validates_endpoints() {
        assert_eq!(
            normalize_endpoint(" https://mail.example.com/ ").unwrap(),
            "https://mail.example.com"
        );
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_endpoint("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert!(normalize_endpoint("http://mail.example.com").is_err());
        assert!(normalize_endpoint("https://user:pass@mail.example.com").is_err());
        assert!(normalize_endpoint("https://mail.example.com?foo=1").is_err());
        assert!(normalize_endpoint("https://mail.example.com#frag").is_err());
    }

    #[test]
    fn validates_daily_cap_and_confidence_bounds() {
        assert_eq!(parse_daily_cap("0").unwrap(), 0.0);
        assert_eq!(parse_daily_cap("0.25").unwrap(), 0.25);
        assert!(parse_daily_cap("-1").is_err());
        assert!(parse_daily_cap("NaN").is_err());
        assert!(parse_daily_cap("inf").is_err());

        assert_eq!(parse_confidence("0.5").unwrap(), 0.5);
        assert_eq!(parse_confidence("1").unwrap(), 1.0);
        assert!(parse_confidence("0.49").is_err());
        assert!(parse_confidence("1.01").is_err());
        assert!(parse_confidence("NaN").is_err());
    }

    #[test]
    fn formats_and_redacts_api_errors() {
        let token = "lm_live_secret_token_value";
        let err = api_error(
            reqwest::StatusCode::UNAUTHORIZED,
            Some("req-123"),
            &format!(r#"{{"error":"bad token {token}","details":{{"reason":"revoked"}}}}"#),
            Some(token),
        );
        let msg = err.to_string();
        assert!(!msg.contains(token));
        assert!(msg.contains("<redacted>"));
        assert!(msg.contains("revoked"));
        assert!(msg.contains("req-123"));
        assert!(msg.contains("lmail login"));

        let html_err = api_error(
            reqwest::StatusCode::BAD_GATEWAY,
            None,
            "<html><body>502 Bad Gateway</body></html>",
            None,
        );
        assert!(html_err.to_string().contains("non-JSON page"));
        assert!(!html_err.to_string().contains("<html>"));
    }

    #[test]
    fn rejects_empty_and_non_json_bodies_without_leaking_payload() {
        let empty = parse_json_body(reqwest::StatusCode::OK, "application/json", b"   ")
            .unwrap_err()
            .to_string();
        assert!(empty.contains("empty body"));

        let secret = "lm_live_should_never_appear";
        let bad = parse_json_body(reqwest::StatusCode::OK, "text/plain", secret.as_bytes())
            .unwrap_err()
            .to_string();
        assert!(!bad.contains(secret));
        assert!(bad.contains("not valid JSON"));
    }

    #[test]
    fn resolves_and_validates_tokens() {
        let mut store = Map::new();
        let key = credential_key("https://mail.example.com", "default");
        store.insert(key, Value::String("  lm_live_stored  ".to_owned()));

        assert_eq!(
            resolve_token(None, &store, "https://mail.example.com", "default").unwrap(),
            "lm_live_stored"
        );
        assert_eq!(
            resolve_token(
                Some(std::ffi::OsString::from(" lm_live_env ")),
                &store,
                "https://mail.example.com",
                "default"
            )
            .unwrap(),
            "lm_live_env"
        );
        assert!(
            resolve_token(
                Some(std::ffi::OsString::from("   ")),
                &store,
                "https://mail.example.com",
                "default"
            )
            .is_err()
        );
        assert!(
            resolve_token(
                Some(std::ffi::OsString::from("bad\ntoken")),
                &store,
                "https://mail.example.com",
                "default"
            )
            .is_err()
        );
    }

    #[test]
    fn encodes_path_segments() {
        assert_eq!(segment("../keys/1"), "..%2Fkeys%2F1");
    }

    #[test]
    fn rejects_endpoint_paths_and_unsafe_mta_sts_urls() {
        assert!(normalize_endpoint("https://mail.example.com/subpath").is_err());
        assert!(
            safe_mta_sts_policy_url("https://mta-sts.example.com/.well-known/mta-sts.txt")
                .is_some()
        );
        assert!(
            safe_mta_sts_policy_url("http://mta-sts.example.com/.well-known/mta-sts.txt").is_none()
        );
        assert!(
            safe_mta_sts_policy_url("https://evil.example.com/.well-known/mta-sts.txt").is_none()
        );
        assert!(
            safe_mta_sts_policy_url("https://mta-sts.example.com:8443/.well-known/mta-sts.txt")
                .is_none()
        );
        assert!(safe_mta_sts_policy_url("https://mta-sts.example.com/other").is_none());
    }

    #[test]
    fn neutralizes_terminal_escape_and_bidi_sequences() {
        let spoofed = "bad\x1b]52;c;SGVsbG8=\x07\u{009b}31m\u{202e}evil";
        let sanitized = sanitize_terminal_text(spoofed);
        assert!(!sanitized.contains('\x1b'));
        assert!(!sanitized.contains('\u{009b}'));
        assert!(!sanitized.contains('\u{202e}'));

        let json_escaped =
            escape_json_terminal_hazards("{\"subject\":\"\u{009b}31m\u{202e}spoof\"}");
        assert!(json_escaped.contains("\\u009b"));
        assert!(json_escaped.contains("\\u202e"));
        assert!(!json_escaped.contains('\u{009b}'));
        assert!(!json_escaped.contains('\u{202e}'));
    }
}
