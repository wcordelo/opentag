import { describe, expect, it } from "vitest";
import {
  expiryFrom,
  parseAllowedRedirectOrigins,
  validateOAuthStateConsumeRequest,
  validateOAuthStateIssueRequest,
} from "../src/platform/oauth-state.js";

const origins = parseAllowedRedirectOrigins("https://app.example.test,https://admin.example.test");

describe("OAuth state contracts", () => {
  it("requires an explicit HTTPS origin allowlist and canonicalizes callback URIs", () => {
    expect(validateOAuthStateIssueRequest({
      schemaVersion: 1,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://app.example.test/oauth/callback?provider=google",
      scopes: ["drive.readonly"],
    }, origins)).toMatchObject({
      redirectUri: "https://app.example.test/oauth/callback?provider=google",
    });
    expect(() => validateOAuthStateIssueRequest({
      schemaVersion: 1,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "http://app.example.test/oauth/callback",
      scopes: [],
    }, origins)).toThrow("redirect_uri_not_allowed");
    expect(() => validateOAuthStateIssueRequest({
      schemaVersion: 1,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://untrusted.example.test/oauth/callback",
      scopes: [],
    }, origins)).toThrow("redirect_uri_not_allowed");
  });

  it("does not accept provider authorization codes or token-shaped fields", () => {
    expect(() => validateOAuthStateIssueRequest({
      schemaVersion: 1,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://app.example.test/oauth/callback",
      scopes: [],
      code: "provider-code",
    }, origins)).toThrow("oauth_secret_material_forbidden");
    expect(() => validateOAuthStateConsumeRequest({
      schemaVersion: 1,
      state: "1234567890abcdef",
      nonce: "1234567890abcdef",
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://app.example.test/oauth/callback",
      accessToken: "provider-token",
    }, origins)).toThrow("oauth_secret_material_forbidden");
  });

  it("bounds state lifetime", () => {
    expect(expiryFrom(Date.parse("2026-08-01T20:00:00.000Z"), 300)).toBe("2026-08-01T20:05:00.000Z");
    expect(() => validateOAuthStateIssueRequest({
      schemaVersion: 1,
      tenantId: "tenant-1",
      principalId: "principal-1",
      connectorId: "google_drive",
      marketplaceVersion: "v1",
      redirectUri: "https://app.example.test/oauth/callback",
      scopes: [],
      ttlSeconds: 901,
    }, origins)).toThrow("oauth_state_ttl_invalid");
  });
});
