/**
 * Everything specific to one event. To run Telecast for a different event, change this file and
 * swap the files in public/theme/ (logo, background, mascot, stickers, colours and fonts).
 */
import type { TelecastConfig } from "./src/shared/types.ts";

const config: TelecastConfig = {
  eventName: "Ashford School Christmas Fair",
  timeZone: "Europe/London",

  stickers: [
    ...Array.from({ length: 10 }, (_, i) => `/theme/stickers/sticker${i + 1}.webp`),
    "/theme/stickers/flag.svg",
  ],
  mascot: true,

  defaults: {
    scene: "rotate",

    idle: {
      message: "Welcome to the Christmas Fair!",
      showNext: true,
      stickers: true,
    },

    message: {
      kicker: "Announcement",
      title: "Santa's Grotto is open",
      body: "Slots every half hour in Friars Hall. Limited places on the day.",
      tone: "red",
    },

    countdown: {
      label: "The Fair opens in",
      target: Date.parse("2026-11-28T12:00:00Z"),
      doneText: "The Fair is open!",
    },

    embed: {
      url: "https://pfa.navaratne.uk/",
      showClock: false,
    },

    schedule: {
      title: "Christmas Fair",
      platform: "Sat 28 Nov",
      items: [
        { time: "12:00", title: "gates open", detail: "Ashford Prep School, Great Chart" },
        { time: "12:00", title: "school choir", detail: "At the front of school" },
        { time: "12:30", title: "choir, second set", detail: "Time to be confirmed" },
        { time: "12:00", title: "Santa's Grotto", detail: "Friars Hall, slots every half hour" },
        { time: "12:00", title: "fairground rides", detail: "Swing chairs, climbing wall, bouncy castle" },
        { time: "All day", title: "36 stalls", detail: "Handmade gifts, crafts and wines" },
        { time: "All day", title: "Nordic cafe", detail: "Friars Hall" },
        { time: "15:15", title: "raffle drawn", detail: "£1 everyday raffle, £5 super raffle" },
        { time: "16:00", title: "fair closes", detail: "Thanks for coming!" },
      ],
    },

    rotate: {
      seconds: 20,
      scenes: ["idle", "schedule", "countdown"],
    },

    ticker: {
      enabled: true,
      text: "Raffle tickets £1, super raffle £5, drawn 3:15pm   ·   Santa's Grotto slots every half hour   ·   Nordic cafe in Friars Hall   ·   36 stalls of gifts and crafts",
    },
  },
};

export default config;
