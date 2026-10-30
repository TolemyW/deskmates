import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, redactText, redactValue } from "./redact.js";

describe("redactText (test strategy §4.3: token, cookie, Bearer header, x-api-key)", () => {
  it("scrubs bearer tokens", () => {
    expect(redactText("Authorization: Bearer abcDEF1234567890")).toBe(`Authorization: ${REDACTED}`);
    expect(redactText("got bearer abcDEF1234567890 back")).toBe(`got bearer ${REDACTED} back`);
  });

  it("scrubs sk- keys", () => {
    expect(redactText("key sk-ant-api03-abcdefghijkl end")).toBe(`key ${REDACTED} end`);
  });

  it("scrubs credential environment variables", () => {
    expect(redactText("ANTHROPIC_AUTH_TOKEN=tok_123456 X=1")).toBe(
      `ANTHROPIC_AUTH_TOKEN=${REDACTED} X=1`,
    );
    expect(redactText("ANTHROPIC_API_KEY: whatever")).toBe(`ANTHROPIC_API_KEY=${REDACTED}`);
  });

  it("scrubs cookie and x-api-key headers", () => {
    expect(redactText("Cookie: session=abc; other=def\nnext")).toBe(`Cookie: ${REDACTED}\nnext`);
    expect(redactText("set-cookie: a=b")).toBe(`set-cookie: ${REDACTED}`);
    expect(redactText("x-api-key: zzz")).toBe(`x-api-key: ${REDACTED}`);
  });

  it("scrubs exact known secrets even when they look ordinary", () => {
    expect(redactText("the value is hunter22 ok", ["hunter22"])).toBe(
      `the value is ${REDACTED} ok`,
    );
    expect(redactText("ab", ["ab"])).toBe("ab");
  });
});

describe("redactValue", () => {
  it("walks objects and arrays, and replaces sensitive keys wholesale", () => {
    const input = {
      command: "curl -H 'Authorization: Bearer abcdefgh12345678' https://x",
      headers: { Cookie: "a=b", Accept: "*/*" },
      nested: [{ token: "t" }, "sk-abcdefghijklmnop"],
      count: 3,
    };
    expect(redactValue(input)).toEqual({
      command: `curl -H 'Authorization: ${REDACTED}' https://x`,
      headers: { Cookie: REDACTED, Accept: "*/*" },
      nested: [{ token: REDACTED }, REDACTED],
      count: 3,
    });
  });

  it("does not mutate its input", () => {
    const input = { token: "t" };
    redactValue(input);
    expect(input.token).toBe("t");
  });
});

describe("redactText: credentials in a URL query string (review M4)", () => {
  it("scrubs the value and keeps the shape of the URL", () => {
    expect(
      redactText("open https://ops.example.test/cb?access_token=abcdefghijklmnop&next=/home"),
    ).toBe(`open https://ops.example.test/cb?access_token=${REDACTED}&next=/home`);
  });

  it.each([
    "token",
    "access_token",
    "api_key",
    "apikey",
    "key",
    "sig",
    "signature",
    "session",
    "sid",
    "auth",
  ])("scrubs ?%s=", (param) => {
    const out = redactText(`https://h/x?${param}=abcdefghijklmnop&page=2`);
    expect(out).toBe(`https://h/x?${param}=${REDACTED}&page=2`);
  });

  it("scrubs a credential that is not the first query parameter", () => {
    expect(redactText("https://h/x?page=2&sig=deadbeefcafe")).toBe(
      `https://h/x?page=2&sig=${REDACTED}`,
    );
  });

  it("scrubs several credentials in one string", () => {
    expect(redactText("a https://h/1?token=aaaa b https://h/2?sid=bbbb c")).toBe(
      `a https://h/1?token=${REDACTED} b https://h/2?sid=${REDACTED} c`,
    );
  });

  it("leaves ordinary query parameters alone", () => {
    const url = "https://ops.example.test/tickets?status=open&page=2&sort=created";
    expect(redactText(url)).toBe(url);
  });
});

describe("redactText: a cookie assigned in page script (review M4)", () => {
  it("scrubs sid= after document.cookie", () => {
    const out = redactText('await page.evaluate(() => document.cookie = "sid=abcdef123")');
    expect(out).not.toContain("abcdef123");
    expect(out).toContain(`cookie: ${REDACTED}`);
  });

  it("scrubs a cookie assignment however it is quoted", () => {
    for (const src of [
      "document.cookie = 'sid=abcdef123'",
      'document.cookie="sid=abcdef123"',
      "document.cookie = sid=abcdef123",
      "Cookie: sid=abcdef123; theme=dark",
    ]) {
      expect(redactText(src)).not.toContain("abcdef123");
    }
  });

  it("leaves a cookie mentioned without a value alone", () => {
    expect(redactText("the cookie jar is at /work/cookies")).toBe(
      "the cookie jar is at /work/cookies",
    );
  });
});

describe("isSensitiveKey: whole words, not substrings (review M4)", () => {
  it.each([
    "client_secret",
    "clientSecret",
    "api_secret",
    "apiSecret",
    "secret_key",
    "secretKey",
    "sessionid",
    "sessionId",
    "session_id",
    "passwd",
    "password",
    "passwords",
    "token",
    "access_token",
    "refresh_token",
    "authToken",
    "modelAuthToken",
    "api_key",
    "apikey",
    "apiKey",
    "x-api-key",
    "X-API-Key",
    "authorization",
    "Authorization",
    "cookie",
    "Cookie",
    "cookies",
    "set-cookie",
    "credential",
    "credentials",
    "secret",
    "secrets",
  ])("%s is a credential key", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "runId",
    "threadId",
    "botId",
    "approvalId",
    "workspaceId",
    "toolUseId",
    "tokens_used",
    "tokensUsed",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreateTokens",
    "tokenizer",
    "keyboard",
    "monkey",
    "sessionCount",
    "command",
    "element",
    "url",
  ])("%s is not a credential key", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactValue applies the key rule (review M4)", () => {
  it("redacts the new keys and leaves the token counts alone", () => {
    expect(
      redactValue({
        client_secret: "abc",
        api_secret: "abc",
        secret_key: "abc",
        sessionid: "abc",
        passwd: "abc",
        clientSecret: "abc",
        "x-api-key": "abc",
        runId: "run-1",
        threadId: "thread-1",
        tokens_used: 1234,
        inputTokens: 120,
      }),
    ).toEqual({
      client_secret: REDACTED,
      api_secret: REDACTED,
      secret_key: REDACTED,
      sessionid: REDACTED,
      passwd: REDACTED,
      clientSecret: REDACTED,
      "x-api-key": REDACTED,
      runId: "run-1",
      threadId: "thread-1",
      tokens_used: 1234,
      inputTokens: 120,
    });
  });

  /**
   * A `screenshot` payload has to reach the ledger byte for byte: the run screen rebuilds a data
   * URL from `mimeType` + `base64`, and one character replaced by `[redacted]` makes an image
   * that will not decode. The redactor works on text patterns and credential key names, and
   * `base64` is neither — the image is not redacted at all, which is why the README calls a
   * screenshot ledger data with the sensitivity of page content.
   */
  it("leaves a screenshot payload intact", () => {
    const payload = {
      toolName: "mcp__browser__browser_click",
      toolUseId: "toolu_01",
      action: 3,
      mimeType: "image/jpeg",
      base64: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a",
      bytes: 57,
      takenAt: "2026-09-22T10:00:00.000Z",
    };
    expect(redactValue(payload, ["deskmates-run-token-9f3c2a1b7e"])).toEqual(payload);
  });

  it("reaches credential keys nested in arrays and objects", () => {
    expect(
      redactValue({ items: [{ headers: { "Set-Cookie": "a=b" }, credentials: { pw: "x" } }] }),
    ).toEqual({ items: [{ headers: { "Set-Cookie": REDACTED }, credentials: REDACTED }] });
  });
});

describe("redactText: credential spellings in shell commands and URLs (#62 M9)", () => {
  it.each([
    [
      "curl -d 'client_secret=abc123def&grant_type=client_credentials' https://h/token",
      `curl -d 'client_secret=${REDACTED}&grant_type=client_credentials' https://h/token`,
    ],
    ["curl -d password=hunter2 https://h/login", `curl -d password=${REDACTED} https://h/login`],
    [
      `curl -H 'Content-Type: application/json' -d '{"password":"hunter2"}' https://h/login`,
      `curl -H 'Content-Type: application/json' -d '{"password":"${REDACTED}"}' https://h/login`,
    ],
    ["curl -u user:pass https://h/", `curl -u user:${REDACTED} https://h/`],
    ["curl --user user:pass https://h/", `curl --user user:${REDACTED} https://h/`],
    ["curl -uuser:pass https://h/", `curl -uuser:${REDACTED} https://h/`],
    [
      "git clone https://user:pass@host.example/repo.git",
      `git clone https://user:${REDACTED}@host.example/repo.git`,
    ],
    ["https://h/cb?password=hunter2&next=/", `https://h/cb?password=${REDACTED}&next=/`],
    ["https://h/cb?refresh_token=abcdef", `https://h/cb?refresh_token=${REDACTED}`],
    ["https://h/cb?id_token=abcdef", `https://h/cb?id_token=${REDACTED}`],
    ["https://h/cb?pwd=abcdef", `https://h/cb?pwd=${REDACTED}`],
    ["PGPASSWORD=s3cret psql -h db", `PGPASSWORD=${REDACTED} psql -h db`],
    ["PGPASSWORD='a b' psql", `PGPASSWORD=${REDACTED} psql`],
    ["MYSQL_PWD=s3cret mysql", `MYSQL_PWD=${REDACTED} mysql`],
    [
      `GITHUB_TOKEN=${"ghp"}_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list`,
      `GITHUB_TOKEN=${REDACTED} gh pr list`,
    ],
    [
      "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
      `export AWS_SECRET_ACCESS_KEY=${REDACTED}`,
    ],
    ["DB_PASSWORD: hunter2", `DB_PASSWORD=${REDACTED}`],
  ])("scrubs %j", (text, expected) => {
    expect(redactText(text)).toBe(expected);
  });

  // Built from parts so a secret scanner on the public mirror does not take the samples for keys.
  it.each([
    `git push https://${"ghp"}_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r`,
    `token ${"github"}_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz`,
    `slack ${"xoxb"}-1234567890-0987654321-abcdefABCDEF`,
    `slack ${"xoxp"}-1234567890-abcdef`,
    `key id ${"AKIA"}IOSFODNN7EXAMPLE`,
    `jwt ${"eyJ"}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`,
  ])("scrubs a well-known token prefix in %j", (text) => {
    const out = redactText(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/ghp_a|github_pat_1|xox[bp]-1|AKIAI|eyJzdWIi/);
  });

  it.each([
    "write to ops@example.test about the password policy",
    "the password must be at least 12 characters",
    "https://ops.example.test/tickets?status=open&page=2",
    "https://ops.example.test:8443/a/b@c",
    "git push -u origin main",
    "git push -u origin feature:main",
    "docker run -u 1000:1000 image",
    "cd $PWD && PWD=/work/bots/nova ls",
    "MAX_TOKENS=4096 TOKENS_USED=12 npm test",
    "sort -k2 key=value notes.txt",
    "echo $GITHUB_TOKEN",
  ])("leaves ordinary text alone: %j", (text) => {
    expect(redactText(text)).toBe(text);
  });
});

describe("redactText: database, sshpass, --password and escaped JSON spellings (#62)", () => {
  it.each([
    ["mysql -uroot -phunter2 shop", `mysql -uroot -p${REDACTED} shop`],
    ["mysql -u root -p hunter2 shop", `mysql -u root -p ${REDACTED} shop`],
    ["mysqldump -h db -p'a b' shop", `mysqldump -h db -p${REDACTED} shop`],
    ["mysql --password=hunter2 shop", `mysql --password=${REDACTED} shop`],
    ["mysql --password hunter2 shop", `mysql --password ${REDACTED} shop`],
    ["wget --http-password=hunter2 https://h/", `wget --http-password=${REDACTED} https://h/`],
    ["sshpass -p hunter2 ssh ops@h", `sshpass -p ${REDACTED} ssh ops@h`],
    ["sshpass -phunter2 ssh ops@h", `sshpass -p${REDACTED} ssh ops@h`],
    ["password: hunter2", `password: ${REDACTED}`],
    ["  db_password: hunter2\nhost: db", `  db_password: ${REDACTED}\nhost: db`],
    ["Password:hunter2", `Password: ${REDACTED}`],
    [
      String.raw`curl -d "{\"user\":\"ops\",\"password\":\"hunter2\"}" https://h/login`,
      String.raw`curl -d "{\"user\":\"ops\",\"password\":\"${REDACTED}\"}" https://h/login`,
    ],
    [
      String.raw`curl -d "{\"client_secret\": \"abc123\"}" https://h/token`,
      String.raw`curl -d "{\"client_secret\": \"${REDACTED}\"}" https://h/token`,
    ],
    ["curl -u ops:hunter2 https://h/", `curl -u ops:${REDACTED} https://h/`],
    ["curl -u 1000:2000 https://h/", `curl -u 1000:${REDACTED} https://h/`],
    ["wget --user ops:hunter2 https://h/", `wget --user ops:${REDACTED} https://h/`],
  ])("scrubs %j", (text, expected) => {
    expect(redactText(text)).toBe(expected);
  });

  // A bare `key=` is redacted only when its value looks like a credential: 16 or more
  // characters, or 8 or more with both a letter and a digit.
  it.each([
    ["https://h/x?key=abcdefghijklmnop", `https://h/x?key=${REDACTED}`],
    ["https://h/x?key=a1b2c3d4&page=2", `https://h/x?key=${REDACTED}&page=2`],
    ["https://h/x?page=2&key=AIzaSyA1b2C3d4E5f6", `https://h/x?page=2&key=${REDACTED}`],
    ["https://h/x?api_key=abc", `https://h/x?api_key=${REDACTED}`],
  ])("scrubs a credential-looking key in %j", (text, expected) => {
    expect(redactText(text)).toBe(expected);
  });

  it.each([
    "https://h/list?key=sort&page=2",
    "https://h/list?key=created_at",
    "https://h/i18n?key=title2",
    "docker run -u app:app image",
    "ssh -p 2222 ops@h",
    "docker login --password-stdin",
    "mysql -p -h db shop",
    "the password must be at least 12 characters",
    "Enter password:",
  ])("leaves ordinary text alone: %j", (text) => {
    expect(redactText(text)).toBe(text);
  });

  // A rule that looks back for the command name at every position is quadratic on one long line
  // (a base64 body, a minified page); a 20 kB line took seconds. These stay linear.
  it.each([
    ["base64", "QUJD".repeat(250_000)],
    ["a curl command", `curl -d @- https://h/ ${"a ".repeat(250_000)}-u ops:pw`],
    ["a mysql command", `mysql ${"-h db -p ".repeat(125_000)}`],
    ["double-dashed words", "a--b ".repeat(200_000)],
    ["password words", "db_password ".repeat(80_000)],
  ])("redacts a one-megabyte line of %s in linear time", (_, text) => {
    const started = performance.now();
    redactText(text);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
