/**
 * Robust mobile-safe file picker.
 *
 * The input element MUST be appended to the DOM before click(): iOS Safari
 * silently ignores click() on detached file inputs — which presented as
 * "menu item does nothing" after the first import attempt on mobile.
 * The `cancel` event resolves the promise with null (modern browsers);
 * the change/resolve path cleans the input up either way.
 */
export const pickFile = (
  accept: readonly string[],
  ownerDocument: Document,
): Promise<File | null> =>
  new Promise((resolve) => {
    const input = ownerDocument.createElement("input");
    input.type = "file";
    input.accept = accept.join(",");
    input.style.position = "fixed";
    input.style.top = "-1000px";
    input.style.left = "0";
    input.style.opacity = "0";
    ownerDocument.body.appendChild(input);

    const done = (file: File | null) => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
      resolve(file);
    };
    const onChange = () => done(input.files?.[0] ?? null);
    const onCancel = () => done(null);
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);

    input.click();
  });
