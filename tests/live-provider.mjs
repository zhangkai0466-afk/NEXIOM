// Opt-in live checks use a dedicated NEXIOM configuration, never Codex login.
export async function configureLiveProvider(core) {
  const endpoint = process.env.NEXIOM_TEST_API_ENDPOINT;
  const model = process.env.NEXIOM_TEST_MODEL;
  const apiKey = process.env.NEXIOM_TEST_API_KEY;
  if (!endpoint || !model || !apiKey)
    throw new Error(
      "Set NEXIOM_TEST_API_ENDPOINT, NEXIOM_TEST_MODEL and NEXIOM_TEST_API_KEY for this opt-in live test. Personal Codex credentials are not used.",
    );
  const current = core.snapshot().snapshot.providers.find(
    (provider) => provider.id === "nexiom-default",
  );
  if (current?.endpoint === endpoint && current.model === model && current.auth === "bearer") {
    core.setRuntimeSecrets({ "nexiom-default": apiKey });
    return;
  }
  await core.request({
    type: "provider.upsert",
    provider: {
      id: "nexiom-default",
      name: "NEXIOM live test",
      kind: "responses",
      endpoint,
      model,
      auth: "bearer",
    },
    apiKey,
  });
}
