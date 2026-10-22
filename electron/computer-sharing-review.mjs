/** Local-native consent boundary. Remote renderers never receive its IPC bridge. */
export async function reviewSharedComputerGrant({ env, input, controller, validateFolders, confirm, enable, assertWorkspace }) {
  const info = await controller().inspectIdentity(env);
  const folders = await validateFolders(input?.folders);
  const detail = [
    `Workspace: ${env.origin}`,
    ...folders.map(folder => `${folder.write ? "Read and write" : "Read only"}: ${folder.path}`),
    input?.terminal === true ? "Terminal: UNRESTRICTED commands as your user. Can access files outside the folders above, including credentials." : "Terminal: off",
    input?.computer === true ? "Computer control: can view your screen and operate logged-in apps. Can access information outside the folders above." : "Computer control: off",
    input?.browser === true ? "Browser: bots open a BOS browser window here and use your signed-in sites in it. You can watch, type and take over." : "Browser: off",
    "Shared content is sent to this hosted workspace and may reach its model provider. Bots from this workspace can use these permissions until you revoke them. Closing the desktop stops access.",
  ].join("\n\n");
  const confirmation = await confirm({ type: "warning", message: `Allow computer access for ${env.name}?`, detail, buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
  if (confirmation.response !== 0) return null;
  assertWorkspace();
  await enable();
  return controller().save(env, { folders, terminal: input?.terminal === true, computer: input?.computer === true, browser: input?.browser === true }, info);
}
