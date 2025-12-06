---
layout: home

hero:
  name: "Firestore Repo Service"
  text: "Type-safe Firestore repositories"
  tagline: Auto-generated methods, full TypeScript support, relations with select, and advanced querying.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/solarpush/firestore-repo-service

features:
  - title: 🎯 Type-Safe
    details: Full TypeScript support with complete type inference. WhereClause as tuples, select with keyof.
  - title: 🚀 Auto-Generated
    details: Automatically generates get.by* and query.by* methods based on your foreignKeys and queryKeys config.
  - title: 🔗 Relations & Populate
    details: Define relations between repositories and populate with typed select (field projection).
  - title: 🔍 Advanced Querying
    details: Support for OR conditions, sorting, pagination with cursors, select, and include.
  - title: 📊 Aggregations
    details: Count, sum, average with server-side execution for optimal performance.
  - title: 📦 Batch & Bulk
    details: Batch operations (atomic, max 500) and bulk operations (auto-split for large datasets).
---
