// bos bot 3.0: the base smart ui library plus the cards (shared/card-guide.ts
// lists them). Kept apart from `library` so the generated smart-ui skill and
// every flag-off parse stay exactly as before; SmartUi picks this one only
// when asked for cards (the v3 flag on desktop, the phone webview).
import { createLibrary } from "@openuidev/react-lang";
import { CARD_NAMES } from "../../shared/card-guide";
import { CARDS } from "./components/cards";
import { functions } from "./functions";
import { library } from "./library";

export const v3Library = createLibrary({
  root: "Col",
  components: [...Object.values(library.components), ...CARDS],
  functions,
  componentGroups: [
    ...(library.componentGroups ?? []),
    { name: "Cards", components: [...CARD_NAMES] },
  ],
});
