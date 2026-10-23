import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(
    page
      .getByRole("heading", { name: "Welcome to BiBrain." })
      .or(page.getByRole("heading", { name: "Good to see you." })),
  ).toBeVisible();
  await expect(page.getByLabel("Save to your brain")).toBeVisible();
});

test("ordinary capture becomes reviewed current truth and agent retrieval", async ({
  page,
}) => {
  const entity = `browser${Date.now()}`;
  await page
    .getByRole("button", { name: "Save something", exact: false })
    .first()
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Current truth evidence");
  await page
    .getByLabel("Paste something you are working on")
    .fill(`${entity} status active`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save to my brain", exact: true })
    .click();
  await expect(page.getByTestId("original")).toContainText(
    `${entity} status active`,
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  const candidate = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: entity }) });
  await expect(
    candidate.getByRole("button", { name: "Accept reviewed claim" }),
  ).toBeVisible();
  await candidate
    .getByRole("button", { name: "Accept reviewed claim" })
    .click();
  await expect(candidate.getByText("status: active")).toBeVisible();
  const search = await page.request.get(
    `/api/v1/agent/search?project_id=inbox&query=${entity}`,
  );
  expect(search.ok()).toBe(true);
  expect(JSON.stringify(await search.json())).toContain('"value":"active"');
  const ask = await page.request.get(
    `/api/v1/agent/ask?project_id=inbox&question=${entity}%20status`,
  );
  expect((await ask.json()).abstained).toBe(false);
});

test("owner promotes an exact passage from ordinary prose through review", async ({
  page,
}) => {
  const entity = `prose${Date.now()}`;
  const passage = `According to my note, ${entity} is paused this week.`;
  await page
    .getByRole("button", { name: "Save something", exact: false })
    .first()
    .click();
  await page.getByLabel("Title", { exact: true }).fill("Prose evidence");
  await page.getByLabel("Paste something you are working on").fill(passage);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save to my brain", exact: true })
    .click();
  await page.getByRole("button", { name: "Add a fact for review" }).click();
  await page.getByLabel("Topic or entity").fill(entity);
  await page.getByRole("combobox", { name: "Status" }).selectOption("paused");
  await expect(page.getByLabel("Exact passage from original")).toHaveValue(
    passage,
  );
  await page.getByRole("button", { name: "Send for review" }).click();
  const candidate = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: entity }) });
  await expect(
    candidate.getByRole("button", { name: "Accept reviewed claim" }),
  ).toBeVisible();
  await candidate
    .getByRole("button", { name: "Accept reviewed claim" })
    .click();
  await expect(candidate.getByText("status: paused")).toBeVisible();
});

test("owner approves an agent intention into an actionable goal", async ({
  page,
}) => {
  const session = await (await page.request.get("/api/v1/session")).json();
  const title = `Review browser intent ${Date.now()}`;
  const proposed = await page.request.post("/api/v1/agent/intent", {
    headers: { "X-Brain-CSRF": session.csrf },
    data: {
      project_id: "inbox",
      action: "propose",
      text: title,
      review_at: "2026-10-01T10:00:00Z",
    },
  });
  expect(proposed.ok()).toBe(true);
  const gate = await proposed.json();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.reload();
  const candidate = page.locator(`[data-proposal-id="${gate.proposal_id}"]`);
  await expect(
    candidate.getByRole("button", { name: "Approve intention" }),
  ).toBeVisible();
  await candidate.getByRole("button", { name: "Approve intention" }).click();
  await expect(candidate).not.toBeVisible();
  const goals = await (await page.request.get("/api/v1/today")).json();
  expect(
    goals.goals.some(
      (goal: any) => goal.data.title === title && goal.data.preparation_enabled,
    ),
  ).toBe(true);
});
test("chat JSON import is previewed and saved through Connections", async ({
  page,
}) => {
  const marker = `Imported chat ${Date.now()}`;
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByLabel("Choose a chat JSON export").setInputFiles({
    name: "conversations.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        {
          title: marker,
          messages: [
            { role: "user", content: "What should I remember?" },
            { role: "assistant", content: `${marker} is saved as evidence.` },
          ],
        },
      ]),
    ),
  });
  await expect(
    page.getByRole("dialog", { name: "Review import" }),
  ).toContainText(marker);
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "1 saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByPlaceholder("Find a note or conversation…").fill(marker);
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Connections" }),
  ).toBeVisible();
  const dropped = `Dropped note ${Date.now()}`;
  await page.locator(".dropzone").evaluate((element, text) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([text], "dropped.md", { type: "text/markdown" }),
    );
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
    );
  }, dropped);
  await expect(
    page.getByRole("dialog", { name: "Review import" }),
  ).toContainText("dropped.md");
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "1 saved" }),
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
  await page.reload();
  const card = page
    .getByRole("article")
    .filter({ hasText: "Prepared for your goal" })
    .filter({ hasText: "Beta onboarding" });
  // The worker prepares the plan in the background, so check again until it lands.
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 25000 });
  await card.getByRole("button", { name: "Fix" }).click();
  await page
    .getByLabel("Your wording")
    .fill("Run a small paste-first beta experiment.");
  await card.getByRole("button", { name: "Save my version" }).click();
  const toast = page.locator(".tv-toast");
  await expect(toast).toContainText(/plan kept/i);
  // A later edit made inside the undo window must survive the undo.
  const session = await (await page.request.get("/api/v1/session")).json();
  const today = await (await page.request.get("/api/v1/today")).json();
  const goal = today.goals.find((g: any) => g.data.title === "Beta onboarding");
  const edited = await page.request.patch(`/api/v1/goals/${goal.id}`, {
    headers: { "X-Brain-CSRF": session.csrf },
    data: {
      expected_version: goal.version,
      plan: "My later plan edit must survive.",
    },
  });
  expect(edited.ok()).toBe(true);
  await page.getByRole("button", { name: "Undo" }).click();
  // A failed Undo is said once, in the alert region, never also in the toast.
  const changed = "This item changed since you opened it. Refresh to compare.";
  await expect(page.getByRole("alert").filter({ hasText: changed })).toBeVisible();
  await expect(page.getByText(changed)).toHaveCount(1);
  await expect(page.getByText("Undone.")).toHaveCount(0);
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page
    .getByLabel("Project", { exact: true })
    .selectOption({ label: "Beta browser test" });
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
