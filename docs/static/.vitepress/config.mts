import { defineConfig } from "vitepress";

const enSidebar = [
  {
    text: "Guide",
    items: [
      { text: "Getting Started", link: "/guide/getting-started" },
      { text: "Configuration", link: "/guide/configuration" },
      { text: "Relations & Populate", link: "/guide/relations" },
      { text: "Querying", link: "/guide/querying" },
      { text: "Advanced Usage", link: "/guide/advanced" },
      { text: "Admin Server", link: "/guide/admin" },
      { text: "Firestore → SQL Sync", link: "/guide/sync" },
    ],
  },
];

const frSidebar = [
  {
    text: "Guide",
    items: [
      { text: "Démarrage rapide", link: "/fr/guide/getting-started" },
      { text: "Configuration", link: "/fr/guide/configuration" },
      { text: "Relations & Populate", link: "/fr/guide/relations" },
      { text: "Requêtes", link: "/fr/guide/querying" },
      { text: "Usage avancé", link: "/fr/guide/advanced" },
      { text: "Serveur Admin", link: "/fr/guide/admin" },
      { text: "Firestore → SQL Sync", link: "/fr/guide/sync" },
    ],
  },
];

export default defineConfig({
  title: "Firestore Repo Service",
  description:
    "Type-safe Firestore repository service with auto-generated methods",

  locales: {
    root: {
      label: "English",
      lang: "en-US",
    },
    fr: {
      label: "Français",
      lang: "fr-FR",
      themeConfig: {
        nav: [
          { text: "Accueil", link: "/fr/" },
          { text: "Guide", link: "/fr/guide/getting-started" },
        ],
        sidebar: frSidebar,
      },
    },
  },

  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
    ],
    logo: "https://frs.lpdjs.fr/lpdjs/Logo.png",
    sidebar: enSidebar,
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/solarpush/firestore-repo-service",
      },
    ],
  },
});
