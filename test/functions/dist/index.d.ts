export declare const server: import("firebase-functions/https").HttpsFunction;
export declare const admin: import("firebase-functions/https").HttpsFunction;
export declare const crud: import("firebase-functions/https").HttpsFunction;
export declare const sync: {
    functions: Record<string, any>;
    adminHandler: ((req: any, res: any) => Promise<void>) | null;
    handleMessage: (event: import("@lpdjs/firestore-repo-service/sync").SyncEvent) => Promise<void>;
    queues: Map<string, import("@lpdjs/firestore-repo-service/sync").SyncQueue>;
    shutdown: () => Promise<void>;
};
