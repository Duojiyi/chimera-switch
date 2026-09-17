import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McodeProviderForm } from "@/components/providers/forms/McodeProviderForm";
import { mcodeProviderPresets } from "@/config/mcodeProviderPresets";
import { piProviderPresets } from "@/config/piProviderPresets";

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    id,
    value,
    onChange,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const original = {
  kind: "custom",
  api: "anthropic-messages",
  enabled: true,
  options: {
    baseURL: "https://api.example.com/anthropic",
    apiKey: "local-test-key",
    headers: { "X-Test": "keep" },
  },
  models: {
    model: {
      name: "Model",
      limit: { context: 200000 },
      thinking: { effort: "high" },
    },
  },
  futureSetting: { keep: true },
};

describe("McodeProviderForm", () => {
  it.each([true, false])(
    "edits native fields while preserving model options and unknown settings (explicit API: %s)",
    async (explicitApi) => {
      const submit = vi.fn();
      const settings: Record<string, unknown> = { ...original };
      if (!explicitApi) delete settings.api;
      render(
        <McodeProviderForm
          appId="mcode"
          providerId="existing"
          initialData={{ name: "Existing", settingsConfig: settings }}
          submitLabel="Save"
          onSubmit={submit}
          onCancel={() => {}}
        />,
      );
      fireEvent.change(screen.getByLabelText("provider.name"), {
        target: { value: "Renamed" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(submit).toHaveBeenCalledOnce());
      const saved = JSON.parse(submit.mock.calls[0][0].settingsConfig);
      expect(saved).toEqual({ ...settings, name: "Renamed" });
      expect(submit.mock.calls[0][0].providerKey).toBe("existing");
      expect(screen.getByLabelText("API Key")).toHaveAttribute(
        "type",
        "password",
      );
    },
  );

  it("keeps a rejected save open and displays the failure", async () => {
    render(
      <McodeProviderForm
        appId="mcode"
        initialData={{ name: "Existing", settingsConfig: original }}
        submitLabel="Save"
        onSubmit={async () => {
          throw new Error("configuration busy");
        }}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "configuration busy",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("uses the shared preset and model editors and saves native API fields", async () => {
    const submit = vi.fn();
    render(
      <McodeProviderForm
        appId="mcode"
        submitLabel="Save"
        onSubmit={submit}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "OpenAI ChimeraHub" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const saved = JSON.parse(submit.mock.calls[0][0].settingsConfig);
    expect(saved.api).toBe("openai-completions");
    expect(saved.options.apiKey).toBe("test-key");
    expect(saved).not.toHaveProperty("npm");
    expect(saved.models).toHaveProperty("gpt-5.6-sol");
  });

  it("keeps invalid JSON drafts from breaking the structured fields", () => {
    render(
      <McodeProviderForm
        appId="mcode"
        initialData={{ name: "Existing", settingsConfig: original }}
        submitLabel="Save"
        onSubmit={vi.fn()}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("provider.configJson"), {
      target: { value: '{"options":{"baseURL":42}}' },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("provider.configJson"), {
      target: { value: JSON.stringify(original) },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("borrows the shared ChimeraHub preset without copying Pi compatibility fields", () => {
    const pi = piProviderPresets.find((preset) => preset.name === "ChimeraHub")!;
    const mcode = mcodeProviderPresets.find(
      (preset) => preset.name === "ChimeraHub",
    )!;
    expect(mcode.settingsConfig.options.baseURL).toBe(
      pi.settingsConfig.baseUrl,
    );
    expect(Object.keys(mcode.settingsConfig.models)).toContain("gpt-5.6-sol");
    expect(mcode.settingsConfig).not.toHaveProperty("compat");
    expect(pi.settingsConfig.models).toBeInstanceOf(Array);
    expect(
      mcodeProviderPresets.every((preset) =>
        [
          "anthropic-messages",
          "openai-completions",
          "openai-responses",
        ].includes(preset.settingsConfig.api),
      ),
    ).toBe(true);
  });
});
