import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {__, initializeI18n, resetI18n} from "../src/i18n";

beforeEach(() => {
  vi.stubGlobal("document", {documentElement: {lang: "en"}});
});

afterEach(() => {
  resetI18n();
  vi.unstubAllGlobals();
});

describe("dashboard localization", () => {
  it("loads the preferred NOC language and existing gettext catalog", async () => {
    const requests: string[] = [];
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url === "/main/desktop/settings/") {
        return new Response(JSON.stringify({language: "pt_BR"}));
      }
      return new Response(
        JSON.stringify({Refresh: [null, "Atualizar"], Overview: "Visão geral"}),
      );
    };

    await expect(initializeI18n(fetcher)).resolves.toBe("pt_BR");

    expect(requests).toEqual([
      "/main/desktop/settings/",
      "/ui/web/translations/pt_BR.json",
    ]);
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(__("Refresh")).toBe("Atualizar");
    expect(__("Overview")).toBe("Visão geral");
    expect(__("Untranslated message")).toBe("Untranslated message");
  });

  it("falls back to English when localization cannot be loaded", async () => {
    const fetcher = async (): Promise<Response> => {
      throw new Error("Network unavailable");
    };

    await expect(initializeI18n(fetcher)).resolves.toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(__("Refresh")).toBe("Refresh");
  });

  it("restores the English language when the selected catalog is unavailable", async () => {
    const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input) === "/main/desktop/settings/") {
        return new Response(JSON.stringify({language: "pt_BR"}));
      }
      return new Response("", {status: 404});
    };

    await expect(initializeI18n(fetcher)).resolves.toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
