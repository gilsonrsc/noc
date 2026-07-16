type CatalogValue = string | [unknown, string | null];
type Catalog = Record<string, CatalogValue>;

interface DesktopSettings {
  language?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let catalog: Catalog = {};

function translatedValue(value: CatalogValue | undefined): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value) && typeof value[1] === "string") return value[1] || undefined;
  return undefined;
}

export function __(message: string): string {
  return translatedValue(catalog[message]) ?? message;
}

export function resetI18n(): void {
  catalog = {};
  document.documentElement.lang = "en";
}

export async function initializeI18n(fetcher: Fetcher = fetch): Promise<string> {
  resetI18n();
  try {
    const settingsResponse = await fetcher("/main/desktop/settings/", {
      cache: "no-store",
      credentials: "same-origin",
      headers: {Accept: "application/json"},
    });
    if (!settingsResponse.ok) return "en";
    const settings = (await settingsResponse.json()) as DesktopSettings;
    const language = settings.language?.match(/^[A-Za-z_]+$/)?.[0] ?? "en";
    document.documentElement.lang = language.replace("_", "-");
    if (language === "en") return language;

    const catalogResponse = await fetcher(`/ui/web/translations/${language}.json`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {Accept: "application/json"},
    });
    if (!catalogResponse.ok) {
      resetI18n();
      return "en";
    }
    catalog = (await catalogResponse.json()) as Catalog;
    return language;
  } catch {
    resetI18n();
    return "en";
  }
}
