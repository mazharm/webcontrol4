import { createDarkTheme, createLightTheme, type BrandVariants } from "@fluentui/react-components";

const brandColors: BrandVariants = {
  10: "#020305",
  20: "#111723",
  30: "#16253D",
  40: "#193253",
  50: "#1B3F6A",
  60: "#1D4D82",
  70: "#1F5B9A",
  80: "#3B82F6",
  90: "#5A9BF7",
  100: "#78B3F8",
  110: "#96CBF9",
  120: "#B4E2FA",
  130: "#D2F0FB",
  140: "#E8F7FD",
  150: "#F5FBFE",
  160: "#FFFFFF",
};

export const lightTheme = createLightTheme(brandColors);
export const darkTheme = createDarkTheme(brandColors);

// Override dark theme to match current SPA aesthetic
darkTheme.colorNeutralBackground1 = "#0f1117";
darkTheme.colorNeutralBackground2 = "#1a1d27";
darkTheme.colorNeutralBackground3 = "#222633";
darkTheme.colorNeutralStroke1 = "#2a2d3a";
darkTheme.colorNeutralStroke2 = "#353849";
