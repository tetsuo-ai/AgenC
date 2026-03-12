export interface TypedArtifactDomain {
  readonly id: string;
  readonly source: string;
  readonly label: string;
  readonly infoToolName: string;
  readonly detailToolName: string;
  readonly routingTerms: readonly string[];
  readonly hardRoutingTerms: readonly string[];
  readonly guidanceDomainTerms: readonly string[];
  readonly guidanceInfoTerms: readonly string[];
  readonly guidanceDetailTerms: readonly string[];
}

export const TYPED_ARTIFACT_DOMAINS: readonly TypedArtifactDomain[] = [
  {
    id: "sqlite",
    source: "typed-sqlite",
    label: "typed SQLite inspection",
    infoToolName: "system.sqliteSchema",
    detailToolName: "system.sqliteQuery",
    routingTerms: ["sqlite", "sql", "query", "queries", "database", "db", "table", "tables", "schema", "schemas", "rows", "columns"],
    hardRoutingTerms: ["sqlite", "sql", "database", "db", "schema", "table", "tables", "query", "queries"],
    guidanceDomainTerms: ["sqlite", "database", "db"],
    guidanceInfoTerms: ["schema", "table", "tables", "column", "columns", "inspect"],
    guidanceDetailTerms: ["query", "rows", "select", "read"],
  },
  {
    id: "pdf",
    source: "typed-pdf",
    label: "typed PDF inspection",
    infoToolName: "system.pdfInfo",
    detailToolName: "system.pdfExtractText",
    routingTerms: ["document", "documents", "pdf", "pdfs", "extract", "metadata", "page", "pages", "report", "reports"],
    hardRoutingTerms: ["pdf", "pdfs"],
    guidanceDomainTerms: ["pdf"],
    guidanceInfoTerms: ["metadata", "page", "pages", "title", "author", "inspect"],
    guidanceDetailTerms: ["extract", "text", "content", "read"],
  },
  {
    id: "spreadsheet",
    source: "typed-spreadsheet",
    label: "typed spreadsheet inspection",
    infoToolName: "system.spreadsheetInfo",
    detailToolName: "system.spreadsheetRead",
    routingTerms: ["spreadsheet", "spreadsheets", "workbook", "workbooks", "sheet", "sheets", "excel", "csv", "tsv", "xlsx", "xls", "header", "headers", "cells"],
    hardRoutingTerms: ["spreadsheet", "spreadsheets", "workbook", "workbooks", "sheet", "sheets", "excel", "csv", "tsv", "xlsx", "xls"],
    guidanceDomainTerms: ["spreadsheet", "workbook", "sheet", "xlsx", "xls", "csv", "tsv"],
    guidanceInfoTerms: ["inspect", "header", "headers", "metadata", "sheet", "sheets"],
    guidanceDetailTerms: ["read", "rows", "cells", "values"],
  },
  {
    id: "office-document",
    source: "typed-office-document",
    label: "typed office document inspection",
    infoToolName: "system.officeDocumentInfo",
    detailToolName: "system.officeDocumentExtractText",
    routingTerms: ["docx", "odt", "word", "writer", "office", "proposal", "memo", "letter", "brief", "transcript"],
    hardRoutingTerms: ["docx", "odt", "word", "writer", "office"],
    guidanceDomainTerms: ["docx", "odt", "office", "word", "writer"],
    guidanceInfoTerms: ["metadata", "title", "creator", "inspect"],
    guidanceDetailTerms: ["extract", "text", "content", "read"],
  },
  {
    id: "email-message",
    source: "typed-email-message",
    label: "typed email message inspection",
    infoToolName: "system.emailMessageInfo",
    detailToolName: "system.emailMessageExtractText",
    routingTerms: ["attachment", "attachments", "email", "emails", "eml", "inbox", "mail", "subject", "thread"],
    hardRoutingTerms: ["attachment", "attachments", "email", "emails", "eml", "inbox", "mail", "subject", "thread"],
    guidanceDomainTerms: ["email", "eml", "mail", "inbox"],
    guidanceInfoTerms: ["metadata", "subject", "sender", "recipient", "inspect"],
    guidanceDetailTerms: ["extract", "text", "body", "attachment", "attachments", "read"],
  },
  {
    id: "calendar",
    source: "typed-calendar",
    label: "typed calendar inspection",
    infoToolName: "system.calendarInfo",
    detailToolName: "system.calendarRead",
    routingTerms: ["attendee", "attendees", "availability", "calendar", "calendars", "ics", "invite", "invites", "meeting", "meetings", "organizer", "organizers", "schedule", "scheduled", "timezone"],
    hardRoutingTerms: ["attendee", "attendees", "calendar", "calendars", "ics", "invite", "invites", "meeting", "meetings", "organizer", "organizers", "schedule", "scheduled", "timezone"],
    guidanceDomainTerms: ["calendar", "ics", "invite", "meeting", "meetings"],
    guidanceInfoTerms: ["metadata", "inspect", "calendar"],
    guidanceDetailTerms: ["attendee", "attendees", "event", "events", "read", "schedule", "scheduled"],
  },
] as const;

export function createTypedArtifactToolNameSet(
  domainId: string,
): ReadonlySet<string> {
  const domain = getTypedArtifactDomain(domainId);
  return new Set([domain.infoToolName, domain.detailToolName]);
}

export function createTypedArtifactTermSet(
  domainId: string,
  field: "routingTerms" | "hardRoutingTerms",
): ReadonlySet<string> {
  return new Set(getTypedArtifactDomain(domainId)[field]);
}

export function getTypedArtifactDomain(domainId: string): TypedArtifactDomain {
  const domain = TYPED_ARTIFACT_DOMAINS.find((entry) => entry.id === domainId);
  if (!domain) {
    throw new Error(`Unknown typed artifact domain: ${domainId}`);
  }
  return domain;
}

export function matchesTypedArtifactTerms(
  terms: readonly string[],
  domain: TypedArtifactDomain,
  field: "routingTerms" | "hardRoutingTerms" | "guidanceDomainTerms" | "guidanceInfoTerms" | "guidanceDetailTerms",
): boolean {
  return terms.some((term) => domain[field].includes(term));
}

function escapeTypedArtifactRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function messageContainsTypedArtifactTerm(
  messageText: string,
  term: string,
): boolean {
  const normalizedMessage = messageText.toLowerCase();
  const normalizedTerm = term.toLowerCase().trim();
  if (normalizedTerm.length === 0) return false;

  const boundaryAwareTerm = new RegExp(
    `(^|[^a-z0-9])${escapeTypedArtifactRegex(normalizedTerm)}(?=$|[^a-z0-9])`,
    "i",
  );
  return boundaryAwareTerm.test(normalizedMessage);
}

export function messageContainsAnyTypedArtifactTerm(
  messageText: string,
  terms: readonly string[],
): boolean {
  return terms.some((term) => messageContainsTypedArtifactTerm(messageText, term));
}
