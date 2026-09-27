import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(
    page
      .getByRole("heading", { name: "What do you want to pick up later?" })
      .or(page.getByRole("heading", { name: "Welcome back." })),
  ).toBeVisible();
});
test("real capture, evidence, editable understanding, download, correction, delete and reload", async ({
  page,
}) => {
  const phrase = `Browser arbitrary 🧠 ${Date.now()}`;
  await page.screenshot({
    path: "docs/screenshots/first-use.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save something", exact: false })
    .first()
    .click();
  await page.getByLabel("Title", { exact: true }).fill("Browser original");
  await page
    .getByLabel("Paste something you are working on")
    .fill(`${phrase}. The launch is Monday.`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save to my brain", exact: true })
    .click();
  await expect(page.getByTestId("original")).toContainText(phrase);
  await expect(
    page.getByRole("button", {
      name: "Continue in another agent",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/source-preview.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Edit understanding", exact: true })
    .click();
  await page
    .getByLabel("Your understanding", { exact: true })
    .fill(`${phrase}. My reviewed understanding.`);
  await page
    .getByRole("button", { name: "Save understanding", exact: true })
    .click();
  await expect(
    page.getByText("Your understanding:", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue in another agent", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Markdown" }).click();
  const file = await downloadPromise;
  expect(file.suggestedFilename()).toBe("bi-brain-brief.md");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("button", { name: /Browser original/ }).click();
  await expect(page.getByTestId("original")).toContainText(phrase);
  await page.getByRole("button", { name: "Correct or move source" }).click();
  await page
    .getByLabel("Source text", { exact: true })
    .fill(`${phrase}. The launch is Friday.`);
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByTestId("original")).toContainText("Friday");
  await page.getByRole("button", { name: "Earlier version" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText(`${phrase}. The launch is Monday.`, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Return to current original" })
    .click();
  await page.getByRole("button", { name: "Delete / withdraw" }).click();
  await page.getByLabel("Type DELETE to permanently purge").fill("DELETE");
  await page
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByLabel("Search saved material").fill(phrase);
  await expect(page.getByLabel("Search saved material")).toHaveValue(phrase);
  await expect(
    page.getByRole("heading", { name: "No matching notes." }),
  ).toBeVisible();
});
test("chosen goal prepares a hypothesis and acceptance undo preserves later edits", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Beta browser test");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  for (const body of [
    "Beta onboarding requires connecting an agent first.",
    "Beta interview asks to try one conversation before connecting accounts.",
  ]) {
    await page
      .getByRole("button", { name: "Save something", exact: false })
      .first()
      .click();
    await page.getByLabel("Title", { exact: true }).fill(body.slice(0, 24));
    await page.getByLabel("Paste something you are working on").fill(body);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save to my brain", exact: true })
      .click();
    await expect(page.getByTestId("original")).toContainText(body);
    await page.getByRole("button", { name: "Close dialog" }).click();
  }
  await page
    .getByRole("button", { name: "Choose a goal", exact: true })
    .click();
  await page
    .getByLabel("What do you want to accomplish?")
    .fill("Beta onboarding");
  await page
    .getByLabel("What would success look like?")
    .fill("Test a beta brief");
  await page.getByRole("button", { name: "Save goal", exact: true }).click();
  await page.getByLabel("Keep this up to date").check();
  await expect(page.getByRole("button", { name: "Prepare now" })).toBeEnabled();
  await page.getByRole("button", { name: "Prepare now" }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Review the plan" }).click();
  await expect(
    page.getByText("No accepted plan yet.", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Proposed plan — edit before accepting")
    .fill("Run a small paste-first beta experiment.");
  await page
    .getByRole("button", { name: "Keep this plan", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Plan accepted", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("button", { name: "Edit plan", exact: true }).click();
  await page
    .getByLabel("Plan", { exact: true })
    .fill("My later plan edit must survive.");
  await page.getByRole("button", { name: "Save plan revision" }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Undo acceptance" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "My later plan edit must survive.",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Undo cannot replace a later edit.",
  );
  await page.getByRole("button", { name: "Keep current plan" }).click();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("button", { name: "Edit plan", exact: true }).click();
  await expect(page.getByLabel("Plan", { exact: true })).toHaveValue(
    "My later plan edit must survive.",
  );
});
test("keyboard dialog and responsive layout at 320, 360, tablet and desktop", async ({
  page,
}) => {
  for (const width of [320, 360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("button", { name: "Today", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByRole("button", { name: "Save something", exact: false })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save something", exact: false }).first(),
  ).toBeFocused();
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await page.getByLabel("Dark appearance").check();
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
});
test("invalid input remains editable, Markdown files persist, and search matches beyond preview snippets", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .getByRole("button", { name: "Save something", exact: false })
    .first()
    .click();
  await page.getByLabel("Title", { exact: true }).fill("Input limit check");
  const oversized = "a".repeat(100001);
  await page.getByLabel("Paste something you are working on").fill(oversized);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save to my brain", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "100,000",
  );
  await expect(
    page.getByLabel("Paste something you are working on"),
  ).toHaveValue(oversized);
  const body =
    "An arbitrary Markdown note. " +
    "Long retained passage. ".repeat(50) +
    "LATE_SEARCH_QUIET_SENTINEL";
  await page.getByLabel("Or import a text file").setInputFiles({
    name: "Long note.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(body),
  });
  await expect(
    page.getByLabel("Paste something you are working on"),
  ).toHaveValue(body);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save to my brain", exact: true })
    .click();
  await expect(page.getByTestId("original")).toContainText(
    "LATE_SEARCH_QUIET_SENTINEL",
  );
  await page
    .getByRole("button", { name: "Continue in another agent", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy brief", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "An arbitrary Markdown note.",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page
    .getByLabel("Search saved material")
    .fill("LATE_SEARCH_QUIET_SENTINEL");
  await expect(page.getByRole("button", { name: /Long note/ })).toBeVisible();
});

