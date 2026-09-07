import { handlePublicDrive } from "./_publicDrive.js";

export const config = { runtime: "edge" };
export default function handler(request) { return handlePublicDrive(request); }
