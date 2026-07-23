import { z } from "zod";
import { planfixPost, planfixGet } from "../client.js";
import { formatContactList, formatSingleContact, formatCreated, formatUpdated } from "../format.js";
import { refuseUnscopedMutation } from "../safemode.js";

const CONTACT_FIELDS = "id,name,midname,lastname,email,phones,company";

export const getContactsSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Contacts per page (default 100, API max 100)"),
  filterId: z.union([z.string(), z.number()]).optional().describe("ID of a saved contact filter"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${CONTACT_FIELDS})`),
});

export async function handleGetContacts(params: z.infer<typeof getContactsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  const result = await planfixPost("contact/list", {
    offset,
    pageSize,
    fields: params.fields ?? CONTACT_FIELDS,
    ...(params.filterId !== undefined ? { filterId: String(params.filterId) } : {}),
  });
  return formatContactList(result, pageSize, offset);
}

export const getContactSchema = z.object({
  contactId: z.number().describe("Contact ID"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${CONTACT_FIELDS})`),
});

export async function handleGetContact(params: z.infer<typeof getContactSchema>): Promise<string> {
  const result = await planfixGet(`contact/${params.contactId}`, { fields: params.fields ?? CONTACT_FIELDS });
  return formatSingleContact(result);
}

export const createContactSchema = z.object({
  name: z.string().describe("Contact name (or company name)"),
  email: z.string().optional().describe("Email"),
  phone: z.string().optional().describe("Phone number"),
  companyId: z.number().optional().describe("ID of the company to link the contact to"),
  isCompany: z.boolean().optional().describe("true — create a company instead of a person"),
});

export async function handleCreateContact(params: z.infer<typeof createContactSchema>): Promise<string> {
  refuseUnscopedMutation("create_contact", `contact "${params.name}"`, "contacts have no project scoping in Planfix");
  const body: Record<string, unknown> = { name: params.name };
  if (params.email) body.email = params.email;
  if (params.phone) body.phones = [{ number: params.phone }];
  if (params.companyId) body.company = { id: params.companyId };
  if (params.isCompany !== undefined) body.isCompany = params.isCompany;

  const result = await planfixPost("contact/", body);
  return formatCreated("Контакт", result);
}

export const updateContactSchema = z.object({
  contactId: z.number().describe("Contact ID"),
  name: z.string().optional().describe("New name"),
  email: z.string().optional().describe("New email"),
  phone: z.string().optional().describe("New phone number"),
});

export async function handleUpdateContact(params: z.infer<typeof updateContactSchema>): Promise<string> {
  refuseUnscopedMutation("update_contact", `contact ${params.contactId}`, "contacts have no project scoping in Planfix");
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.email) body.email = params.email;
  if (params.phone) body.phones = [{ number: params.phone }];

  await planfixPost(`contact/${params.contactId}`, body);
  return formatUpdated("Контакт", params.contactId);
}
