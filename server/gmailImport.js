import path from "path";
import fs from "fs-extra";
import { pipeline } from "stream/promises";
import { config } from "./config.js";
import { readLtaRef } from "./excelParser.js";

// Import tab, Gmail source: read the "LTA Complet" emails (and their .xlsx
// attachment — "generated_excel - <ref>.xlsx", or just "generated_excel.xlsx" in
// newer emails) straight from the Gmail account that sends them, over IMAP —
// independent of Outlook, classic or new.
//
// NOTE: `imapflow` is imported LAZILY, like nodemailer in notifications.js. A
// static import would crash the whole API server on a machine where
// `npm install` hasn't been run since the dependency was added.

/** Error with a machine-readable `code` so the caller can choose a fallback. */
export class GmailImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // NO_CREDENTIALS | NO_PACKAGE | AUTH | NETWORK | MAILBOX | OTHER
  }
}

/** True when IMAP credentials are configured (the package is checked on use). */
export const isGmailConfigured = () =>
  Boolean(config.imap.user && config.imap.pass);

// Gmail shows app passwords as "abcd efgh ijkl mnop"; the spaces are cosmetic.
const cleanPassword = (pass) =>
  /^([a-z]{4} ){3}[a-z]{4}$/i.test(pass) ? pass.replace(/ /g, "") : pass;

const sanitizeFileName = (name) =>
  path.basename(String(name)).replace(/[\\/:*?"<>|]/g, "_");

const decodeEncodedWords = (text) =>
  text.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, enc, data) => {
    try {
      const bytes =
        enc.toLowerCase() === "b"
          ? Buffer.from(data, "base64")
          : Buffer.from(
              data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });

/**
 * File name from a MIME part's header block, read leniently. Needed because the
 * program that generates the "LTA Complet" emails writes
 *   Content-Disposition: attachment; filename= generated_excel - 065-45991864.xlsx
 * (unquoted, with spaces): Outlook accepts that, but Gmail's BODYSTRUCTURE
 * parser rejects it and reports the attachment with no name at all. Handles
 * quoted / unquoted values, RFC 2231 (`filename*=utf-8''...`) and RFC 2047
 * encoded words.
 */
export const filenameFromMimeHeader = (headerText) => {
  const text = String(headerText).replace(/\r?\n[ \t]+/g, " "); // unfold
  const star = text.match(/\bfilename\*\s*=\s*[^'\s;]*'[^']*'([^;\r\n]*)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain forms */
    }
  }
  const m =
    text.match(/\bfilename\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/i) ||
    text.match(/\bname\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/i);
  return m ? decodeEncodedWords((m[1] ?? m[2] ?? "").trim()) : "";
};

/**
 * Part ids of the non-text leaf parts that have NO file name in the parsed
 * BODYSTRUCTURE — their MIME headers have to be read to learn it.
 */
export const unnamedLeafParts = (node, out = []) => {
  if (!node) return out;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) unnamedLeafParts(child, out);
    return out;
  }
  const named = node.dispositionParameters?.filename || node.parameters?.name;
  if (!named && !/^text\//i.test(node.type || "")) out.push(node.part || "1");
  return out;
};

/** File name of a leaf node: from the parsed structure, else from its MIME headers. */
const leafName = (node, names) =>
  node.dispositionParameters?.filename || node.parameters?.name || names[node.part || "1"] || "";

/**
 * Names of every non-text attachment in an IMAP BODYSTRUCTURE tree (for the
 * diagnostic log). `names` maps a part id to a name read from its MIME headers.
 */
export const attachmentNames = (node, names = {}, out = []) => {
  if (!node) return out;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) attachmentNames(child, names, out);
    return out;
  }
  if (!/^text\//i.test(node.type || "")) out.push(leafName(node, names) || `(sans nom, ${node.type || "?"})`);
  return out;
};

/**
 * Every .xlsx attachment in an IMAP BODYSTRUCTURE tree. Nodes follow imapflow's
 * shape: { part, type, parameters, dispositionParameters, childNodes }. A
 * single-part message has no `part` (its body is part "1"). `names` maps a part
 * id to a file name read from its MIME headers, for parts the structure left
 * unnamed (see filenameFromMimeHeader).
 */
export const findXlsxParts = (node, names = {}, out = []) => {
  if (!node) return out;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    for (const child of node.childNodes) findXlsxParts(child, names, out);
    return out;
  }
  const filename = leafName(node, names);
  if (/\.xlsx$/i.test(filename)) out.push({ part: node.part || "1", filename });
  return out;
};

/**
 * Which of a mail's .xlsx parts to import for `ref`: those whose name contains
 * the ref ("generated_excel - 235-98898074.xlsx"); failing that, the only .xlsx
 * of the mail — newer emails attach a plain "generated_excel.xlsx" without the
 * ref, the subject (already matched on the ref) being what identifies the LTA.
 * Several .xlsx and none named with the ref is ambiguous → nothing is chosen.
 */
export const choosePartsForRef = (xlsxParts, ref) => {
  const named = xlsxParts.filter((p) => p.filename.includes(ref));
  if (named.length) return named;
  return xlsxParts.length === 1 ? xlsxParts : [];
};

// "[ERREUR DUM] LTA Complet - …": the generator flags a faulty run in the subject.
const isErrorMail = (subject) => /\[\s*erreur/i.test(subject);

/**
 * Pick the email to import for `ref` among fetched candidates
 * ({ uid, subject, date, structure, names }): subject contains the ref AND the
 * keyword (default "complet") AND the message carries an .xlsx (see
 * choosePartsForRef). Emails NOT flagged "[ERREUR …]" win over flagged ones even
 * when older (importing a faulty Excel would mean signing wrong DUMs); among
 * equals the most recent wins (a later "Updated" resend replaces an earlier one).
 * `best.errorMail` is set when only flagged emails exist. `noXlsx` is set when a
 * matching email exists but has no usable .xlsx (`ambiguous` when it has several).
 */
export const pickCandidate = (candidates, ref, keyword) => {
  const refLc = ref.toLowerCase();
  const kw = keyword.toLowerCase();
  let best = null;
  let noXlsx = false;
  let ambiguous = false;
  for (const c of candidates) {
    const subject = String(c.subject || "").toLowerCase();
    if (!subject.includes(refLc) || !subject.includes(kw)) continue;
    const xlsxParts = findXlsxParts(c.structure, c.names);
    const parts = choosePartsForRef(xlsxParts, ref);
    if (!parts.length) {
      noXlsx = true;
      if (xlsxParts.length > 1) ambiguous = true;
      continue;
    }
    const errorMail = isErrorMail(subject);
    const time = c.date ? new Date(c.date).getTime() : 0;
    const better =
      !best ||
      (best.errorMail && !errorMail) ||
      (best.errorMail === errorMail && (time > best.time || (time === best.time && c.uid > best.uid)));
    if (better) best = { ...c, parts, time, errorMail };
  }
  return { best, noXlsx, ambiguous };
};

const classify = (err) => {
  const text = `${err?.message || ""} ${err?.responseText || ""}`;
  if (err?.authenticationFailed || /auth|credentials|invalid login|application-specific/i.test(text))
    return "AUTH";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timeout|socket|getaddrinfo/i.test(text))
    return "NETWORK";
  return "OTHER";
};

/**
 * Search the Gmail account for each ref and save the matching .xlsx into
 * `dest`. Resolves { results: [{ ref, status, detail }], debug: [...] } with the
 * same statuses as the Outlook import: saved | no_xlsx | not_found | error.
 * Throws GmailImportError when the account itself can't be used (no
 * credentials, package missing, bad login, network) — the caller may then fall
 * back to Outlook.
 */
export const fetchXlsxFromGmail = async ({ refs, dest, keyword = "complet" }) => {
  if (!isGmailConfigured())
    throw new GmailImportError(
      "NO_CREDENTIALS",
      "Identifiants Gmail absents (EMAIL_USER / EMAIL_PASS dans .env).",
    );

  let ImapFlow;
  try {
    const mod = await import("imapflow");
    ImapFlow = mod.ImapFlow || mod.default?.ImapFlow;
    if (!ImapFlow) throw new Error("ImapFlow export not found");
  } catch {
    throw new GmailImportError(
      "NO_PACKAGE",
      "Le paquet « imapflow » n'est pas installé — lancez `npm install` dans le dossier de l'app.",
    );
  }

  const debug = [];
  const log = (line) => debug.push(line);
  const { host, port, user } = config.imap;
  const client = new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass: cleanPassword(config.imap.pass) },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
  // Without a listener an emitted 'error' (e.g. a dropped socket) would crash Node.
  client.on("error", (e) => log(`IMAP error event: ${e.message}`));

  const results = [];
  try {
    try {
      await client.connect();
    } catch (err) {
      throw new GmailImportError(
        classify(err),
        classify(err) === "AUTH"
          ? `Connexion Gmail refusée pour ${user} — vérifiez le mot de passe d'application (EMAIL_PASS).`
          : `Connexion à ${host} impossible : ${err.message}`,
      );
    }
    log(`Gmail IMAP connected as ${user}`);

    // "All Mail" covers sent + received and is found by its special-use flag, so
    // it works whatever language the account uses; fall back to Sent, then INBOX.
    const boxes = await client.list();
    const box =
      boxes.find((b) => b.specialUse === "\\All") ||
      boxes.find((b) => b.specialUse === "\\Sent");
    const mailbox = box?.path || "INBOX";
    log(`Searching mailbox: ${mailbox}`);

    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const ref of refs) {
        try {
          const found = (await client.search({ subject: ref }, { uid: true })) || [];
          log(`[${ref}] subject search matched=${found.length}`);

          // Newest first, capped: a ref only ever has a handful of emails.
          const uids = [...found].sort((a, b) => b - a).slice(0, 30);
          const candidates = [];
          if (uids.length) {
            for await (const msg of client.fetch(
              uids,
              { uid: true, envelope: true, bodyStructure: true, internalDate: true },
              { uid: true },
            )) {
              candidates.push({
                uid: msg.uid,
                subject: msg.envelope?.subject || "",
                date: msg.internalDate || msg.envelope?.date,
                structure: msg.bodyStructure,
              });
            }
          }
          // Only plausible mails (ref + keyword in the subject) are worth a second
          // look: when the structure gives their attachments no name, read the
          // names from the parts' own MIME headers (outside the fetch loop above —
          // commands can't be issued while iterating a fetch).
          for (const c of candidates) {
            const subject = String(c.subject).toLowerCase();
            if (!subject.includes(ref.toLowerCase()) || !subject.includes(keyword.toLowerCase())) continue;
            const unnamed = unnamedLeafParts(c.structure);
            if (!unnamed.length) continue;
            try {
              const got = await client.fetchOne(
                String(c.uid),
                { bodyParts: unnamed.map((p) => `${p}.mime`) },
                { uid: true },
              );
              c.names = {};
              for (const p of unnamed) {
                const buf = got?.bodyParts?.get(`${p}.mime`);
                const name = buf ? filenameFromMimeHeader(buf.toString("utf8")) : "";
                if (name) c.names[p] = name;
              }
            } catch (err) {
              log(`[${ref}] uid=${c.uid} could not read attachment headers: ${err.message}`);
            }
          }
          for (const c of candidates.slice(0, 10)) {
            const atts = attachmentNames(c.structure, c.names || {});
            log(
              `[${ref}] candidate uid=${c.uid} ${c.date ? new Date(c.date).toISOString().slice(0, 16) : "?"} subj=${c.subject}` +
                (atts.length ? ` attachments=${atts.join(" | ")}` : ""),
            );
          }

          const { best, noXlsx, ambiguous } = pickCandidate(candidates, ref, keyword);
          if (!best) {
            results.push(
              noXlsx
                ? {
                    ref,
                    status: "no_xlsx",
                    detail: ambiguous
                      ? "Email trouvé dans Gmail avec plusieurs pièces .xlsx, aucune nommée avec la ref — impossible de choisir"
                      : "Email trouvé dans Gmail mais aucune pièce .xlsx",
                  }
                : { ref, status: "not_found", detail: `Aucun email « ${keyword} » avec pièce .xlsx pour ${ref} dans Gmail` },
            );
            continue;
          }
          log(`[${ref}] chosen uid=${best.uid} subj=${best.subject}`);

          const saved = [];
          for (const p of best.parts) {
            // Always stored as "generated_excel - <ref>.xlsx" when the attachment
            // is just "generated_excel.xlsx" — the file name is the app's key for
            // an LTA, so two plain names would overwrite each other.
            const finalName = p.filename.includes(ref)
              ? sanitizeFileName(p.filename)
              : `generated_excel - ${ref}.xlsx`;
            const finalPath = path.join(dest, finalName);
            // Download beside the final name and only move it in once it checks
            // out, so a bad download never replaces a good earlier copy.
            const tmpPath = path.join(dest, `.${finalName}.part`);
            try {
              const { content } = await client.download(String(best.uid), p.part, { uid: true });
              await pipeline(content, fs.createWriteStream(tmpPath));
              // An .xlsx is a zip ("PK"): guards against a body saved still encoded.
              const head = Buffer.alloc(2);
              const fd = await fs.open(tmpPath, "r");
              await fs.read(fd, head, 0, 2, 0);
              await fs.close(fd);
              if (head.toString("latin1") !== "PK")
                throw new Error(`Le fichier ${p.filename} téléchargé n'est pas un .xlsx valide`);
              // The app derives the LTA from the file's CONTENT: it must be the
              // one asked for, or the wrong LTA would be signed under this ref.
              let inside;
              try {
                inside = readLtaRef(tmpPath);
              } catch (e) {
                throw new Error(`Le fichier ${p.filename} est illisible (${e.message})`);
              }
              if (inside !== ref)
                throw new Error(
                  inside
                    ? `Le fichier ${p.filename} de l'email contient la LTA ${inside} et non ${ref} — non importé`
                    : `Aucune référence LTA lisible dans ${p.filename} — non importé`,
                );
              await fs.move(tmpPath, finalPath, { overwrite: true });
            } finally {
              await fs.remove(tmpPath).catch(() => {});
            }
            saved.push(finalName);
          }
          results.push({
            ref,
            status: "saved",
            detail:
              saved.join(" ; ") +
              (best.errorMail
                ? ` — ⚠ seul un email « ${best.subject} » existe : vérifiez le fichier avant de signer`
                : ""),
          });
        } catch (err) {
          log(`[${ref}] error: ${err.message}`);
          results.push({ ref, status: "error", detail: `Gmail : ${err.message}` });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
  return { results, debug, account: user };
};
