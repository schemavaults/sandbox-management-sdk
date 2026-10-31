import { withSchemaVaultsTailwindTheme } from "@schemavaults/theme";
import type { Config } from "tailwindcss";
import defaultTheme from "tailwindcss/defaultTheme";

// The SchemaVaults theme supplies the color tokens, radii, breakpoints and the
// `dark` class strategy. "@schemavaults/ui" is resolved to the installed
// package's dist folder so the classes its components use are generated too.
const base = withSchemaVaultsTailwindTheme({
  content: ["./src/**/*.{ts,tsx}", "@schemavaults/ui"],
});

const config: Config = {
  ...base,
  theme: {
    ...base.theme,
    extend: {
      ...base.theme?.extend,
      fontFamily: {
        sans: ["var(--font-geist-sans)", ...defaultTheme.fontFamily.sans],
        mono: ["var(--font-geist-mono)", ...defaultTheme.fontFamily.mono],
      },
    },
  },
};

export default config;
