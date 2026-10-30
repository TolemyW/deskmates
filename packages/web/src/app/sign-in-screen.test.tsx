// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthClient } from "../api/auth-client.js";
import type { SessionFlows } from "../api/members-client.js";
import { SignInScreen } from "./sign-in-screen.js";

afterEach(cleanup);

it("prevents competing sign-ins while SSO starts and unlocks after failure", async () => {
  let rejectStart!: (reason: Error) => void;
  const startSso = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        rejectStart = reject;
      }),
  );
  const login = vi.fn();
  render(
    <SignInScreen
      flows={{ startSso } as unknown as SessionFlows}
      auth={{ login } as unknown as AuthClient}
      view={{
        authenticated: false,
        setupRequired: false,
        loginCsrf: "test-csrf",
        ssoProviders: [{ id: "sso-test", displayName: "Example" }],
      }}
      notice={undefined}
      onSignedIn={() => {}}
      onStale={() => {}}
    />,
  );
  const button = screen.getByRole("button", { name: /Example/ });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(screen.getByLabelText("Password")).toBeDisabled();
  fireEvent.click(button);
  expect(startSso).toHaveBeenCalledTimes(1);
  await act(async () => {
    rejectStart(new Error("offline"));
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(button).toBeEnabled();
  expect(screen.getByLabelText("Password")).toBeEnabled();
  expect(login).not.toHaveBeenCalled();
});
