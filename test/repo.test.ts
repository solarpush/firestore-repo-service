/**
 * Comprehensive test suite for firestore-repo-service
 * Run with: bun test test/repo.test.ts
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  clearEmulatorData,
  createTestRepositories,
  exportIndexUsage,
  initializeFirestore,
  waitForEmulator,
  type TestRepositories,
} from "./setup";

/**
 * Helper to check if a value is a Timestamp or Date
 */
function isTimestampOrDate(value: unknown): boolean {
  return value instanceof Date || value instanceof Timestamp;
}

/**
 * Helper to convert Timestamp to Date for comparison
 */
function toDate(value: Date | Timestamp): Date {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  return value;
}

// ============================================
// Test Suite Setup
// ============================================

let repos: TestRepositories;

beforeAll(async () => {
  // Check emulator is available
  const available = await waitForEmulator(10, 500);
  if (!available) {
    throw new Error(
      "Firestore emulator is not available. Start it with: bun run emulator"
    );
  }

  // Initialize Firestore and repositories
  const db = initializeFirestore();
  repos = createTestRepositories(db);
});

beforeEach(async () => {
  // Clear data between tests
  await clearEmulatorData();
});

afterAll(async () => {
  // Export index usage at the end
  const indexes = await exportIndexUsage();
  if (indexes) {
    console.log("\n📊 Index Usage Report:");
    console.log(JSON.stringify(indexes, null, 2));
  }
});

// ============================================
// CRUD Tests
// ============================================

describe("CRUD Operations", () => {
  describe("create()", () => {
    test("should create a document with auto-generated ID", async () => {
      const user = await repos.users.create({
        email: "test@example.com",
        name: "Test User",
        age: 25,
        isActive: true,
        tags: ["developer"],
        metadata: { role: "admin", level: 1 },
      });

      expect(user.docId).toBeDefined();
      expect(user.documentPath).toBe(`users/${user.docId}`);
      expect(user.email).toBe("test@example.com");
      expect(user.name).toBe("Test User");
      expect(isTimestampOrDate(user.createdAt)).toBe(true);
      expect(isTimestampOrDate(user.updatedAt)).toBe(true);
    });

    test("should create a document with custom ID", async () => {
      const customId = "custom-user-id";
      const user = await repos.users.create({
        docId: customId,
        email: "custom@example.com",
        name: "Custom User",
        age: 30,
        isActive: false,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      expect(user.docId).toBe(customId);
      expect(user.documentPath).toBe(`users/${customId}`);
    });

    test("should set createdAt and updatedAt automatically", async () => {
      const before = new Date();
      const user = await repos.users.create({
        email: "timestamp@example.com",
        name: "Timestamp User",
        age: 20,
        isActive: true,
        tags: [],
        metadata: { role: "guest", level: 0 },
      });
      const after = new Date();

      const createdAt = toDate(user.createdAt);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
      expect(isTimestampOrDate(user.updatedAt)).toBe(true);
    });
  });

  describe("update()", () => {
    test("should update specific fields", async () => {
      const user = await repos.users.create({
        email: "update@example.com",
        name: "Original Name",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const originalUpdatedAt = user.updatedAt;

      // Wait a bit to ensure updatedAt changes
      await new Promise((r) => setTimeout(r, 10));

      const updated = await repos.users.update(user.docId, {
        name: "Updated Name",
        age: 26,
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.age).toBe(26);
      expect(updated.email).toBe("update@example.com"); // Unchanged
      expect(toDate(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        toDate(originalUpdatedAt).getTime()
      );
    });
  });

  describe("set()", () => {
    test("should set document with merge", async () => {
      const user = await repos.users.create({
        email: "set@example.com",
        name: "Set User",
        age: 30,
        isActive: true,
        tags: ["tag1"],
        metadata: { role: "user", level: 1 },
      });

      const result = await repos.users.set(
        user.docId,
        { name: "Merged Name" },
        { merge: true }
      );

      expect(result.name).toBe("Merged Name");
      expect(result.email).toBe("set@example.com"); // Preserved with merge
    });
  });

  describe("delete()", () => {
    test("should delete a document", async () => {
      const user = await repos.users.create({
        email: "delete@example.com",
        name: "Delete User",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      await repos.users.delete(user.docId);

      const fetched = await repos.users.get.byDocId(user.docId);
      expect(fetched).toBeNull();
    });
  });
});

// ============================================
// Get Methods Tests
// ============================================

describe("Get Methods", () => {
  describe("get.byForeignKey()", () => {
    test("should get document by docId", async () => {
      const user = await repos.users.create({
        email: "getby@example.com",
        name: "Get By User",
        age: 28,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const fetched = await repos.users.get.byDocId(user.docId);
      expect(fetched).not.toBeNull();
      expect(fetched?.docId).toBe(user.docId);
      expect(fetched?.email).toBe("getby@example.com");
    });

    test("should get document by email", async () => {
      const uniqueEmail = `unique-${Date.now()}@example.com`;
      await repos.users.create({
        email: uniqueEmail,
        name: "Email User",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const fetched = await repos.users.get.byEmail(uniqueEmail);
      expect(fetched).not.toBeNull();
      expect(fetched?.email).toBe(uniqueEmail);
    });

    test("should return null for non-existent document", async () => {
      const fetched = await repos.users.get.byDocId("non-existent-id");
      expect(fetched).toBeNull();
    });
  });

  describe("get.byList()", () => {
    test("should get multiple documents by list of IDs", async () => {
      const user1 = await repos.users.create({
        email: "list1@example.com",
        name: "List User 1",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });
      const user2 = await repos.users.create({
        email: "list2@example.com",
        name: "List User 2",
        age: 30,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const fetched = await repos.users.get.byList(
        "docId",
        [user1.docId, user2.docId],
        "in"
      );

      expect(fetched).toHaveLength(2);
      expect(fetched.map((u) => u.docId)).toContain(user1.docId);
      expect(fetched.map((u) => u.docId)).toContain(user2.docId);
    });
  });
});

// ============================================
// Query Methods Tests
// ============================================

describe("Query Methods", () => {
  describe("query.by*()", () => {
    test("should query by queryKey", async () => {
      await repos.users.create({
        email: "active1@example.com",
        name: "Active User 1",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });
      await repos.users.create({
        email: "active2@example.com",
        name: "Active User 2",
        age: 30,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });
      await repos.users.create({
        email: "inactive@example.com",
        name: "Inactive User",
        age: 35,
        isActive: false,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const activeUsers = await repos.users.query.byIsActive(true);
      expect(activeUsers).toHaveLength(2);
      expect(activeUsers.every((u) => u.isActive)).toBe(true);
    });
  });

  describe("query.by()", () => {
    test("should query with multiple where conditions", async () => {
      await repos.users.create({
        email: "match@example.com",
        name: "Match User",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });
      await repos.users.create({
        email: "nomatch@example.com",
        name: "No Match User",
        age: 30,
        isActive: false,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const results = await repos.users.query.by({
        where: [
          ["isActive", "==", true],
          ["age", "<", 30],
        ],
      });

      expect(results).toHaveLength(1);
      expect(results[0].email).toBe("match@example.com");
    });

    test("should query with orderBy and limit", async () => {
      for (let i = 1; i <= 5; i++) {
        await repos.users.create({
          email: `order${i}@example.com`,
          name: `Order User ${i}`,
          age: 20 + i,
          isActive: true,
          tags: [],
          metadata: { role: "user", level: 0 },
        });
      }

      const results = await repos.users.query.by({
        orderBy: [{ field: "age", direction: "desc" }],
        limit: 3,
      });

      expect(results).toHaveLength(3);
      expect(results[0].age).toBe(25);
      expect(results[1].age).toBe(24);
      expect(results[2].age).toBe(23);
    });
  });

  describe("query.getAll()", () => {
    test("should get all documents", async () => {
      await repos.categories.create({
        name: "Cat 1",
        slug: "cat-1",
        postCount: 0,
      });
      await repos.categories.create({
        name: "Cat 2",
        slug: "cat-2",
        postCount: 0,
      });
      await repos.categories.create({
        name: "Cat 3",
        slug: "cat-3",
        postCount: 0,
      });

      const all = await repos.categories.query.getAll();
      expect(all).toHaveLength(3);
    });
  });

  describe("query.paginate()", () => {
    test("should paginate results", async () => {
      // Create 10 posts
      const user = await repos.users.create({
        email: "paginate@example.com",
        name: "Paginate User",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      for (let i = 1; i <= 10; i++) {
        await repos.posts.create({
          userId: user.docId,
          title: `Post ${i}`,
          content: `Content ${i}`,
          status: "published",
          views: i * 10,
          likes: i,
        });
      }

      // First page
      const page1 = await repos.posts.query.paginate({
        pageSize: 3,
        orderBy: [{ field: "views", direction: "asc" }],
      });

      expect(page1.data).toHaveLength(3);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      // Second page
      const page2 = await repos.posts.query.paginate({
        pageSize: 3,
        orderBy: [{ field: "views", direction: "asc" }],
        cursor: page1.nextCursor,
      });

      expect(page2.data).toHaveLength(3);
      expect(page2.hasNextPage).toBe(true);
      // Ensure no overlap
      const page1Ids = page1.data.map((p) => p.docId);
      const page2Ids = page2.data.map((p) => p.docId);
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
    });
  });
});

// ============================================
// Batch Operations Tests
// ============================================

describe("Batch Operations", () => {
  describe("batch.create()", () => {
    test("should batch create multiple documents", async () => {
      const batch = repos.categories.batch.create();

      batch.set("cat-1", {
        name: "Category 1",
        slug: "category-1",
        postCount: 0,
      });
      batch.set("cat-2", {
        name: "Category 2",
        slug: "category-2",
        postCount: 5,
      });
      batch.set("cat-3", {
        name: "Category 3",
        slug: "category-3",
        postCount: 10,
      });

      await batch.commit();

      const all = await repos.categories.query.getAll();
      expect(all).toHaveLength(3);
    });
  });

  describe("batch operations on subcollections", () => {
    test("should batch create comments (subcollection)", async () => {
      // Create a post first
      const user = await repos.users.create({
        email: "batch-comment@example.com",
        name: "Batch Comment User",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const post = await repos.posts.create({
        userId: user.docId,
        title: "Batch Post",
        content: "Content",
        status: "published",
        views: 0,
        likes: 0,
      });

      // Batch create comments
      const batch = repos.comments.batch.create();
      batch.set(post.docId, "comment-1", {
        postId: post.docId,
        userId: user.docId,
        content: "Comment 1",
        likes: 0,
      });
      batch.set(post.docId, "comment-2", {
        postId: post.docId,
        userId: user.docId,
        content: "Comment 2",
        likes: 0,
      });

      await batch.commit();

      const comments = await repos.comments.query.byPostId(post.docId);
      expect(comments).toHaveLength(2);
    });
  });
});

// ============================================
// Bulk Operations Tests
// ============================================

describe("Bulk Operations", () => {
  describe("bulk.set()", () => {
    test("should bulk set multiple documents", async () => {
      // Get the Firestore instance from repos
      const db = initializeFirestore();

      const items = [
        {
          docRef: db.collection("categories").doc("bulk-1"),
          data: { name: "Bulk 1", slug: "bulk-1", postCount: 0 },
        },
        {
          docRef: db.collection("categories").doc("bulk-2"),
          data: { name: "Bulk 2", slug: "bulk-2", postCount: 0 },
        },
        {
          docRef: db.collection("categories").doc("bulk-3"),
          data: { name: "Bulk 3", slug: "bulk-3", postCount: 0 },
        },
      ];

      await repos.categories.bulk.set(items);

      const all = await repos.categories.query.getAll();
      expect(all).toHaveLength(3);
    });
  });

  describe("bulk.update()", () => {
    test("should bulk update multiple documents", async () => {
      const db = initializeFirestore();

      // Create first
      const cat1 = await repos.categories.create({
        name: "Cat 1",
        slug: "cat-1",
        postCount: 0,
      });
      const cat2 = await repos.categories.create({
        name: "Cat 2",
        slug: "cat-2",
        postCount: 0,
      });

      // Bulk update
      await repos.categories.bulk.update([
        {
          docRef: db.collection("categories").doc(cat1.docId),
          data: { postCount: 10 },
        },
        {
          docRef: db.collection("categories").doc(cat2.docId),
          data: { postCount: 20 },
        },
      ]);

      const updated1 = await repos.categories.get.byDocId(cat1.docId);
      const updated2 = await repos.categories.get.byDocId(cat2.docId);

      expect(updated1?.postCount).toBe(10);
      expect(updated2?.postCount).toBe(20);
    });
  });

  describe("bulk.delete()", () => {
    test("should bulk delete multiple documents", async () => {
      const db = initializeFirestore();

      const cat1 = await repos.categories.create({
        name: "Del 1",
        slug: "del-1",
        postCount: 0,
      });
      const cat2 = await repos.categories.create({
        name: "Del 2",
        slug: "del-2",
        postCount: 0,
      });
      await repos.categories.create({
        name: "Keep",
        slug: "keep",
        postCount: 0,
      });

      await repos.categories.bulk.delete([
        db.collection("categories").doc(cat1.docId),
        db.collection("categories").doc(cat2.docId),
      ]);

      const all = await repos.categories.query.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].slug).toBe("keep");
    });
  });
});

// ============================================
// Relations Tests
// ============================================

describe("Relations", () => {
  describe("populate()", () => {
    test("should populate one-to-many relation", async () => {
      const user = await repos.users.create({
        email: "populate@example.com",
        name: "Populate User",
        age: 25,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      await repos.posts.create({
        userId: user.docId,
        title: "Post 1",
        content: "Content 1",
        status: "published",
        views: 10,
        likes: 1,
      });
      await repos.posts.create({
        userId: user.docId,
        title: "Post 2",
        content: "Content 2",
        status: "draft",
        views: 5,
        likes: 0,
      });

      const userWithPosts = await repos.users.populate(
        { docId: user.docId },
        "docId"
      );

      expect(userWithPosts.populated.posts).toHaveLength(2);
      expect(userWithPosts.populated.posts[0].userId).toBe(user.docId);
    });

    test("should populate one-to-one relation", async () => {
      const user = await repos.users.create({
        email: "author@example.com",
        name: "Author",
        age: 30,
        isActive: true,
        tags: [],
        metadata: { role: "author", level: 2 },
      });

      const post = await repos.posts.create({
        userId: user.docId,
        title: "Author Post",
        content: "Content",
        status: "published",
        views: 100,
        likes: 10,
      });

      const postWithUser = await repos.posts.populate(post, "userId");

      expect(postWithUser.populated.users).not.toBeNull();
      expect(postWithUser.populated.users?.email).toBe("author@example.com");
    });

    test("should populate with select (field projection)", async () => {
      const user = await repos.users.create({
        email: "select@example.com",
        name: "Select User",
        age: 25,
        isActive: true,
        tags: ["tag1", "tag2"],
        metadata: { role: "user", level: 1 },
      });

      await repos.posts.create({
        userId: user.docId,
        title: "Select Post",
        content: "Long content here",
        status: "published",
        views: 50,
        likes: 5,
      });

      const userWithPosts = await repos.users.populate(
        { docId: user.docId },
        {
          relation: "docId",
          select: ["docId", "title", "status"],
        }
      );

      expect(userWithPosts.populated.posts).toHaveLength(1);
      // Note: Firestore select still returns the document, but only selected fields
      expect(userWithPosts.populated.posts[0].title).toBe("Select Post");
    });
  });

  describe("paginate with include", () => {
    test("should include related documents in pagination", async () => {
      const user = await repos.users.create({
        email: "include@example.com",
        name: "Include User",
        age: 28,
        isActive: true,
        tags: [],
        metadata: { role: "user", level: 0 },
      });

      const post = await repos.posts.create({
        userId: user.docId,
        title: "Include Post",
        content: "Content",
        status: "published",
        views: 10,
        likes: 1,
      });

      // Create comments
      const batch = repos.comments.batch.create();
      batch.set(post.docId, "c1", {
        postId: post.docId,
        userId: user.docId,
        content: "Comment 1",
        likes: 0,
      });
      batch.set(post.docId, "c2", {
        postId: post.docId,
        userId: user.docId,
        content: "Comment 2",
        likes: 0,
      });
      await batch.commit();

      // Paginate posts with include
      const result = await repos.posts.query.paginate({
        pageSize: 10,
        include: ["userId", "docId"],
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].populated).toBeDefined();
      expect(result.data[0].populated.users).toBeDefined();
      expect(result.data[0].populated.comments).toHaveLength(2);
    });

    test("should include with select", async () => {
      const user = await repos.users.create({
        email: "include-select@example.com",
        name: "Include Select User",
        age: 35,
        isActive: true,
        tags: ["a", "b"],
        metadata: { role: "admin", level: 5 },
      });

      await repos.posts.create({
        userId: user.docId,
        title: "Include Select Post",
        content: "Content",
        status: "published",
        views: 100,
        likes: 10,
      });

      const result = await repos.posts.query.paginate({
        pageSize: 10,
        include: [{ relation: "userId", select: ["docId", "name", "email"] }],
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].populated.users).toBeDefined();
      expect(result.data[0].populated.users?.name).toBe("Include Select User");
    });
  });
});

// ============================================
// Select/Projection Tests
// ============================================

describe("Select/Projection", () => {
  test("should query with select to reduce payload", async () => {
    await repos.users.create({
      email: "projection@example.com",
      name: "Projection User",
      age: 40,
      isActive: true,
      tags: ["heavy", "data"],
      metadata: { role: "admin", level: 10 },
    });

    const results = await repos.users.query.by({
      where: [["email", "==", "projection@example.com"]],
      select: ["docId", "name", "email"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Projection User");
    expect(results[0].email).toBe("projection@example.com");
    // Note: Other fields may be undefined or not present due to select
  });
});

// ============================================
// Aggregate Tests
// ============================================

describe("Aggregate Operations", () => {
  beforeEach(async () => {
    await clearEmulatorData();
    // Create test data
    const user = await repos.users.create({
      email: "agg@example.com",
      name: "Agg User",
      age: 25,
      isActive: true,
      tags: [],
      metadata: { role: "user", level: 0 },
    });

    for (let i = 1; i <= 5; i++) {
      await repos.posts.create({
        userId: user.docId,
        title: `Post ${i}`,
        content: `Content ${i}`,
        status: i <= 3 ? "published" : "draft",
        views: i * 100,
        likes: i * 10,
      });
    }
  });

  describe("aggregate.count()", () => {
    test("should count all documents", async () => {
      const count = await repos.posts.aggregate.count();
      expect(count).toBe(5);
    });

    test("should count with filter", async () => {
      const count = await repos.posts.aggregate.count({
        where: [["status", "==", "published"]],
      });
      expect(count).toBe(3);
    });
  });

  describe("aggregate.sum()", () => {
    test("should sum a field", async () => {
      const total = await repos.posts.aggregate.sum("views");
      // 100 + 200 + 300 + 400 + 500 = 1500
      expect(total).toBe(1500);
    });

    test("should sum with filter", async () => {
      const total = await repos.posts.aggregate.sum("views", {
        where: [["status", "==", "published"]],
      });
      // 100 + 200 + 300 = 600
      expect(total).toBe(600);
    });
  });

  describe("aggregate.average()", () => {
    test("should calculate average", async () => {
      const avg = await repos.posts.aggregate.average("likes");
      // (10 + 20 + 30 + 40 + 50) / 5 = 30
      expect(avg).toBe(30);
    });
  });
});

// ============================================
// Transaction Tests
// ============================================

describe("Transactions", () => {
  test("should perform transaction with get and update", async () => {
    const user = await repos.users.create({
      email: "transaction@example.com",
      name: "Transaction User",
      age: 25,
      isActive: true,
      tags: [],
      metadata: { role: "user", level: 0 },
    });

    const cat = await repos.categories.create({
      name: "Transaction Cat",
      slug: "transaction-cat",
      postCount: 0,
    });

    // Run transaction
    await repos.categories.transaction.run(async (t) => {
      const current = await t.get(cat.docId);
      if (current) {
        t.update(cat.docId, { postCount: current.postCount + 1 });
      }
    });

    const updated = await repos.categories.get.byDocId(cat.docId);
    expect(updated?.postCount).toBe(1);
  });

  test("should rollback transaction on error", async () => {
    const cat = await repos.categories.create({
      name: "Rollback Cat",
      slug: "rollback-cat",
      postCount: 10,
    });

    try {
      await repos.categories.transaction.run(async (t) => {
        t.update(cat.docId, { postCount: 20 });
        throw new Error("Intentional error");
      });
    } catch {
      // Expected error
    }

    const unchanged = await repos.categories.get.byDocId(cat.docId);
    expect(unchanged?.postCount).toBe(10); // Should remain unchanged
  });
});

// ============================================
// Collection Group Tests
// ============================================

describe("Collection Group Queries", () => {
  test("should query across all subcollections", async () => {
    const user = await repos.users.create({
      email: "group@example.com",
      name: "Group User",
      age: 25,
      isActive: true,
      tags: [],
      metadata: { role: "user", level: 0 },
    });

    // Create posts and comments
    const post1 = await repos.posts.create({
      userId: user.docId,
      title: "Post 1",
      content: "Content",
      status: "published",
      views: 10,
      likes: 1,
    });

    const post2 = await repos.posts.create({
      userId: user.docId,
      title: "Post 2",
      content: "Content",
      status: "published",
      views: 20,
      likes: 2,
    });

    // Comments on different posts
    const batch = repos.comments.batch.create();
    batch.set(post1.docId, "c1", {
      postId: post1.docId,
      userId: user.docId,
      content: "Comment on Post 1",
      likes: 5,
    });
    batch.set(post2.docId, "c2", {
      postId: post2.docId,
      userId: user.docId,
      content: "Comment on Post 2",
      likes: 10,
    });
    await batch.commit();

    // Query all comments by userId (collection group query)
    const allComments = await repos.comments.query.byUserId(user.docId);
    expect(allComments).toHaveLength(2);
  });
});
