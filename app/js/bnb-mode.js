/**
 * IT / Backdoors & Breaches-style mode — decks and mechanics.
 *
 * The IT version mirrors Backdoors & Breaches (Black Hills InfoSec): a fully
 * random incident. The Incident Master secretly draws ONE attack card from each
 * of four categories. Defenders run a detection/response Procedure each turn
 * and roll a d20; a roll of 11+ is a success and can reveal the hidden attack
 * card for that category. Three failures in a row (total below 11), or a
 * natural 1 or 20, triggers an INJECT — a random twist that changes the
 * situation. Defenders win by uncovering all four attack cards.
 *
 * Everything here is drawn randomly; there is no authored arc, so replay value
 * is high. The DM (LLM) narrates the fiction; this module owns the deck draws,
 * the secret attack path, and the inject/failure bookkeeping so the mechanics
 * are deterministic and testable.
 */

// ---------------------------------------------------------------------------
// ATTACK CARD DECKS — one card drawn per category = the hidden kill chain.
// ---------------------------------------------------------------------------

export const ATTACK_CATEGORIES = [
  { id: 'initial', name: 'Initial Compromise', prompt: 'How did the attackers first get in?' },
  { id: 'pivot', name: 'Pivot & Escalate', prompt: 'How did they gain privilege once inside?' },
  { id: 'persist', name: 'Persistence', prompt: 'How do they keep their access?' },
  { id: 'c2', name: 'C2 & Exfiltration', prompt: 'How do they talk out and steal data?' },
];

const ATTACK_DECK = {
  initial: [
    { id: 'phish', name: 'Spearphishing Attachment', symptom: 'One user opened a document they were not expecting; a mail client spawned an unusual child process.' },
    { id: 'vpn-cred', name: 'Compromised VPN Credential', symptom: 'A valid VPN login from a new geo with a clean, no-alert device fingerprint.' },
    { id: 'exposed-rdp', name: 'Exposed RDP Service', symptom: 'A jump host answered on 3389 from the internet; a burst of failed logins then one success.' },
    { id: 'supply-chain', name: 'Compromised Software Update', symptom: 'A signed update from a trusted vendor started phoning home to an unknown host.' },
    { id: 'cloud-key', name: 'Leaked Cloud API Key', symptom: 'A committed key in a public repo was used to enumerate storage from an unfamiliar ASN.' },
    { id: 'usb-bait', name: 'Malicious USB / BadUSB', symptom: 'An unlabelled device was plugged into a workstation near the front desk.' },
    { id: 'webapp-exploit', name: 'Public Web App Exploit', symptom: 'The edge web server logged a crafted request immediately followed by a web shell write.' },
    { id: 'mfa-fatigue', name: 'MFA Fatigue / Push Spam', symptom: 'An account was bombarded with push prompts until one was approved at 2 a.m.' },
    { id: 'helpdesk', name: 'Help-Desk Social Engineering', symptom: 'A password reset was performed by phone on an account that then logged in from elsewhere.' },
  ],
  pivot: [
    { id: 'ad-kerberoast', name: 'Kerberoasting', symptom: 'A burst of service-ticket requests for accounts with weak passwords.' },
    { id: 'lsass-dump', name: 'Credential Dump (LSASS)', symptom: 'An endpoint process touched another process memory space outside normal tooling.' },
    { id: 'cloud-role', name: 'Over-Permissive Cloud Role', symptom: 'A workload assumed a role it never used before and listed every resource.' },
    { id: 'pass-reuse', name: 'Password Reuse Across Systems', symptom: 'One leaked password opened three unrelated systems within minutes.' },
    { id: 'admin-share', name: 'Admin Share Access', symptom: 'A workstation reached ADMIN$ on the file server with a non-admin account.' },
    { id: 'token-theft', name: 'Session Token Theft', symptom: 'A browser session moved from two IPs simultaneously.' },
    { id: 'golden-ticket', name: 'Forged Kerberos Ticket', symptom: 'Authentication with a ticket lifetime and group list that should not exist.' },
    { id: 'container-escape', name: 'Container Escape', symptom: 'A container touched the host namespace and mounted a host path.' },
  ],
  persist: [
    { id: 'sched-task', name: 'Scheduled Task', symptom: 'A task registered to run every 30 minutes from a user temp path.' },
    { id: 'svc-account', name: 'Rogue Service Account', symptom: 'A new service account was created and granted interactive logon.' },
    { id: 'ssh-key', name: 'Plant SSH Authorized Key', symptom: 'A new public key appeared in an operations account on two servers.' },
    { id: 'cloud-iam-user', name: 'Backdoor Cloud IAM User', symptom: 'A cloud user was created with programmatic access and no console login.' },
    { id: 'implant-svc', name: 'Malicious Service Install', symptom: 'A service binary was written to ProgramData and set to auto-start.' },
    { id: 'webshell', name: 'Web Shell', symptom: 'A small PHP/JSP file in the web root responds to a magic query string.' },
    { id: 'registry-run', name: 'Registry Run Key', symptom: 'A Run key points at a signed-but-unusual process in a user profile.' },
    { id: 'ci-token', name: 'Backdoored CI Pipeline Secret', symptom: 'A build job exported an environment secret to an external endpoint.' },
  ],
  c2: [
    { id: 'dns-tunnel', name: 'DNS Tunnelling', symptom: 'Long, high-entropy DNS TXT queries to one domain every few seconds.' },
    { id: 'https-beacon', name: 'HTTPS Beacon', symptom: 'Regular, jittered callbacks to a new domain from one host.' },
    { id: 'cloud-storage', name: 'Exfil via Cloud Storage', symptom: 'A workstation PUT files to an unfamiliar bucket and shared an external link.' },
    { id: 'saas-tunnel', name: 'SaaS Tunnelling', symptom: 'Traffic to a legitimate SaaS app that never resolved to its published ranges.' },
    { id: 'smb-over-inet', name: 'SMB over the Internet', symptom: 'Outbound 445 to a random VPS host.' },
    { id: 'paste-exfil', name: 'Exfil via Paste/Temp Site', symptom: 'Large uploads to a paste service from a server that has no browser.' },
    { id: 'mail-rule', name: 'Mail Forwarding Rule', symptom: 'A hidden inbox rule forwards finance mail to an external address.' },
    { id: 'print-night', name: 'Data Staging & Archive', symptom: 'A multi-GB archive was staged in a share hours before a large egress spike.' },
  ],
};

// ---------------------------------------------------------------------------
// PROCEDURE DECK — the capability the Defenders run each turn.
// ---------------------------------------------------------------------------

const PROCEDURE_DECK = [
  { id: 'edr-hunt', name: 'EDR Threat Hunt', skill: 'Endpoint detection & response telemetry' },
  { id: 'net-flow', name: 'Network Flow Analysis', skill: 'NetFlow / packet capture review' },
  { id: 'siem-search', name: 'SIEM Correlation Search', skill: 'Log correlation across sources' },
  { id: 'auth-review', name: 'Authentication Log Review', skill: 'Identity / SSO audit' },
  { id: 'email-review', name: 'Email Gateway Review', skill: 'Mail flow & attachment inspection' },
  { id: 'cloud-audit', name: 'Cloud Audit Trail Review', skill: 'Cloud control-plane logs' },
  { id: 'forensic-image', name: 'Endpoint Forensic Imaging', skill: 'Disk & memory forensics' },
  { id: 'dns-ns', name: 'DNS / Name-Server Analysis', skill: 'Resolver & domain intelligence' },
  { id: 'threat-intel', name: 'Threat Intel Enrichment', skill: 'IOC pivot & attribution' },
  { id: 'vuln-scan', name: 'Vulnerability Scan', skill: 'Exposure validation' },
  { id: 'malware-sandbox', name: 'Malware Sandbox Detonation', skill: 'Dynamic analysis' },
  { id: 'identity-blast', name: 'Identity Blast-Radius Review', skill: 'Access & privilege mapping' },
  { id: 'backup-audit', name: 'Backup & Integrity Audit', skill: 'Tamper detection' },
  { id: 'ir-comms', name: 'IR Comms & Coordination', skill: 'Bridging teams and stakeholders' },
  { id: 'contain-act', name: 'Containment Action', skill: 'Isolate / block / revoke' },
  { id: 'recover-act', name: 'Recovery Action', skill: 'Restore & rebuild clean' },
];

// ---------------------------------------------------------------------------
// INJECT DECK — random twists fired on a nat 1/20 or 3 fails in a row.
// ---------------------------------------------------------------------------

const INJECT_DECK = [
  { id: 'exec-call', text: 'The CEO walks in mid-investigation demanding a status and threatening to call the board if this is not contained by lunch.', tone: 'pressure' },
  { id: 'leak', text: 'A screenshot of your internal incident channel appears on a public forum, captioned as proof of a cover-up.', tone: 'reputation' },
  { id: 'backup-fail', text: 'The backup you were counting on is discovered to be encrypted by the attacker too — the last clean copy is older than anyone thought.', tone: 'setback' },
  { id: 'insider-flag', text: 'A second account with legitimate credentials starts doing the same thing — it may be a second attacker, or a panicked insider.', tone: 'confusion' },
  { id: 'vendor-outage', text: 'The SaaS platform you rely on for visibility goes down for maintenance exactly when you need it.', tone: 'setback' },
  { id: 'reporter', text: 'A journalist emails your comms team with detailed questions that show they already know more than you have confirmed.', tone: 'reputation' },
  { id: 'regulator', text: 'The regulator opens a formal information request with a 24-hour clock.', tone: 'pressure' },
  { id: 'false-flag', text: 'An IOC you were confident in turns out to be a benign internal tool — you may have burned time on a red herring.', tone: 'confusion' },
  { id: 'partner', text: 'A business partner discloses they were breached first and are only now telling you.', tone: 'revelation' },
  { id: 'attacker-taunt', text: 'The attacker leaves a message in a file named "you_missed_me.txt" — they know you are looking.', tone: 'escalation' },
  { id: 'insurance', text: 'Your cyber-insurer sends a list of requirements you must satisfy for the claim to stay valid.', tone: 'pressure' },
  { id: 'law-enforcement', text: 'Law enforcement asks you to preserve everything and not tip off the attacker — which slows your containment.', tone: 'complication' },
  { id: 'cloud-bill', text: 'An egress bill spike suggests far more data left than your logs ever showed.', tone: 'revelation' },
  { id: 'staff-fear', text: 'Staff are refusing to plug into the network and productivity is stalling — morale is now an incident of its own.', tone: 'pressure' },
  { id: 'second-domain', text: 'A brand-new lookalike domain is registered and starts resolving to your employees.', tone: 'escalation' },
  { id: 'good-luck', text: 'A sharp junior analyst spots the thread everyone else missed — a genuine break in the case.', tone: 'boon' },
];

// ---------------------------------------------------------------------------
// Random draw helpers
// ---------------------------------------------------------------------------

const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

/** Draw a full hidden attack path: one card per category. */
export function drawAttackPath(rng = Math.random) {
  return ATTACK_CATEGORIES.map((cat) => {
    const card = pick(ATTACK_DECK[cat.id], rng);
    return { category: cat.id, category_name: cat.name, ...card, revealed: false };
  });
}

/** Draw a random procedure card (the Defenders' capability this turn). */
export function drawProcedure(rng = Math.random) {
  return { ...pick(PROCEDURE_DECK, rng) };
}

/** Draw `n` distinct procedure options (a hand the Defenders can choose from). */
export function drawProcedureHand(n = 3, rng = Math.random) {
  const pool = PROCEDURE_DECK.slice();
  const hand = [];
  for (let i = 0; i < n && pool.length; i++) {
    hand.push({ ...pool.splice(Math.floor(rng() * pool.length), 1)[0] });
  }
  return hand;
}

/** Draw a random inject (avoids repeating ones already fired). */
export function drawInject(firedIds = new Set(), rng = Math.random) {
  const pool = INJECT_DECK.filter((c) => !firedIds.has(c.id));
  const src = pool.length ? pool : INJECT_DECK;
  return { ...pick(src, rng) };
}

export const _decks = { ATTACK_DECK, PROCEDURE_DECK, INJECT_DECK };
