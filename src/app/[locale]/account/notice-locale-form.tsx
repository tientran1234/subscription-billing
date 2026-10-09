"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { locales, type Locale } from "@/i18n";

export interface NoticeLocaleLabels {
  heading: string;
  /** The field: the language we write in, not the one this page is in. */
  field: string;
  /** Which language notices go out in, with the name already in it. */
  current: string;
  save: string;
  saving: string;
  saved: string;
  failed: string;
  note: string;
  /**
   * What each language is called. Written out by the page rather than folded
   * over the list, so a locale added to src/i18n.ts is a compile error there
   * instead of a blank option here.
   */
  names: Record<Locale, string>;
}

type State = "idle" | "saving" | "saved" | "failed";

/**
 * The language this workspace is written to in, as the customer sets it.
 *
 * Each language is named in itself — "Tiếng Việt", not "Vietnamese" — because
 * the reader who needs this control is by definition the one who cannot read
 * the page it sits on.
 *
 * Choosing does not navigate. The page you are reading follows the URL and your
 * browser, and a save that also moved you would make the control look like a
 * page switcher that happens to send mail; what it sets is the language of a
 * notice that arrives tomorrow, with nobody holding a page at all. The note
 * below says so, because a setting whose effect is invisible for a month is one
 * worth spelling out.
 */
export function NoticeLocaleForm({
  locale,
  labels,
}: {
  locale: Locale;
  labels: NoticeLocaleLabels;
}) {
  const router = useRouter();
  const [field, setField] = useState<Locale>(locale);
  const [state, setState] = useState<State>("idle");

  async function save(chosen: Locale) {
    setState("saving");
    try {
      const response = await fetch("/api/locale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locale: chosen }),
      });
      if (!response.ok) return setState("failed");
      setState("saved");
      // The sentence above is rendered from the row, so this is what moves it.
      router.refresh();
    } catch {
      setState("failed");
    }
  }

  const message = state === "saved" ? labels.saved : state === "failed" ? labels.failed : null;

  return (
    <section>
      <h2 className="section">{labels.heading}</h2>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        {labels.current}
      </p>
      <p className="cap">
        <label htmlFor="notice-locale">{labels.field}</label>
        <select
          id="notice-locale"
          value={field}
          onChange={(event) => {
            setField(event.target.value as Locale);
            setState("idle");
          }}
        >
          {locales.map((option) => (
            <option key={option} value={option}>
              {labels.names[option]}
            </option>
          ))}
        </select>
      </p>
      <p className="actions">
        <button
          className="button"
          onClick={() => save(field)}
          disabled={state === "saving" || field === locale}
        >
          {state === "saving" ? labels.saving : labels.save}
        </button>
        {message ? <span className="sub">{message}</span> : null}
      </p>
      <p className="sub">{labels.note}</p>
    </section>
  );
}
