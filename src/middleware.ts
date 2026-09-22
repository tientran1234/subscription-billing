import createMiddleware from "next-intl/middleware";
import { defaultLocale, locales } from "@/i18n";

export default createMiddleware({ locales, defaultLocale });

// Everything except API routes, Next internals and static files.
export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
