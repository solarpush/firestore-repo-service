import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Firestore Repo Service",
  description:
    "Type-safe Firestore repository service with auto-generated methods",
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
    ],
    logo: "https://frs.lpdjs.fr/lpdjs/Logo.png",

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "Relations & Populate", link: "/guide/relations" },
          { text: "Querying", link: "/guide/querying" },
          { text: "Advanced Usage", link: "/guide/advanced" },
        ],
      },
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/solarpush/firestore-repo-service",
      },
    ],
  },
});
