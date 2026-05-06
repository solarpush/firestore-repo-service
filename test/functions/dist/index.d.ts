export declare const server: import("firebase-functions/https").HttpsFunction;
export declare const admin: import("firebase-functions/https").HttpsFunction | (((req: any, res: any) => Promise<void>) & {
    httpsOptions?: import("firebase-functions/https").HttpsOptions;
});
export declare const crud: import("firebase-functions/https").HttpsFunction | (((req: any, res: any) => Promise<void>) & {
    spec: () => import("@lpdjs/firestore-repo-service/dist/openapi-B3P2F8op").O;
    httpsOptions?: import("firebase-functions/https").HttpsOptions;
});
export declare const sync: {
    functions: Record<string, any>;
    adminHandler: ((req: any, res: any) => Promise<void>) | null;
    handleMessage: (event: import("@lpdjs/firestore-repo-service/dist/types-CX5AbZWV").S) => Promise<void>;
    queues: Map<string, import("@lpdjs/firestore-repo-service/dist/queue-D_-aMf4H").S>;
    shutdown: () => Promise<void>;
};
