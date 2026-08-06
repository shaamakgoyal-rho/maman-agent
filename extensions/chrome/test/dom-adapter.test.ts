// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessibleName,
  applyAction,
  collectControls,
  isHiddenByStyleOrAria,
  isSecure,
  readValue,
  roleOf,
} from "../src/lib/dom-adapter.js";

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("roleOf", () => {
  it("maps tags and input types to addressable roles", () => {
    const doc = render(`
      <input id="text" type="text">
      <input id="date" type="date">
      <input id="check" type="checkbox">
      <input id="submit" type="submit">
      <textarea id="area"></textarea>
      <select id="sel"></select>
      <button id="btn"></button>
      <a id="link" href="/x"></a>
      <h2 id="head"></h2>
      <table><tr><td id="cell"></td></tr></table>
    `);
    const role = (id: string) => roleOf(doc.getElementById(id)!);
    expect(role("text")).toBe("textbox");
    expect(role("date")).toBe("textbox");
    expect(role("check")).toBe("checkbox");
    expect(role("submit")).toBe("button");
    expect(role("area")).toBe("textbox");
    expect(role("sel")).toBe("combobox");
    expect(role("btn")).toBe("button");
    expect(role("link")).toBe("link");
    expect(role("head")).toBe("heading");
    expect(role("cell")).toBe("cell");
  });

  it("prefers an explicit ARIA role and normalises gridcell", () => {
    const doc = render(`<div id="a" role="textbox"></div><div id="b" role="gridcell"></div>`);
    expect(roleOf(doc.getElementById("a")!)).toBe("textbox");
    expect(roleOf(doc.getElementById("b")!)).toBe("cell");
  });

  it("declines to address controls it cannot identify unambiguously", () => {
    const doc = render(`
      <input id="radio" type="radio">
      <input id="file" type="file">
      <input id="hidden" type="hidden">
      <a id="anchor"></a>
      <div id="div"></div>
      <div id="unknown" role="tooltip"></div>
    `);
    for (const id of ["radio", "file", "hidden", "anchor", "div", "unknown"]) {
      expect(roleOf(doc.getElementById(id)!), id).toBeUndefined();
    }
  });
});

describe("isSecure — refuses on doubt", () => {
  it("flags password fields and payment/credential autocompletes", () => {
    const doc = render(`
      <input id="pw" type="password">
      <input id="cc" type="text" autocomplete="cc-number">
      <input id="otp" type="text" autocomplete="one-time-code">
      <input id="newpw" type="text" autocomplete="new-password">
    `);
    for (const id of ["pw", "cc", "otp", "newpw"]) {
      expect(isSecure(doc.getElementById(id)!), id).toBe(true);
    }
  });

  it("flags credential-shaped names and ids even on a plain text input", () => {
    const doc = render(`
      <input id="a" type="text" name="user_password">
      <input id="api_token" type="text">
      <input id="c" type="text" name="cvv">
      <input id="d" type="text" name="ssn">
      <textarea id="e" name="secret_notes"></textarea>
      <select id="f" name="mfa_method"></select>
    `);
    for (const id of ["a", "api_token", "c", "d", "e", "f"]) {
      expect(isSecure(doc.getElementById(id)!), id).toBe(true);
    }
  });

  it("treats freeform editable regions as out of scope", () => {
    const doc = render(`<div id="rich" role="textbox" contenteditable="true"></div>`);
    expect(isSecure(doc.getElementById("rich")!)).toBe(true);
  });

  it("treats a password manager's injected UI as not part of the page", () => {
    const doc = render(`<div data-1p-ignore><input id="pm" type="text" name="username"></div>`);
    expect(isSecure(doc.getElementById("pm")!)).toBe(true);
  });

  it("clears an ordinary labelled business field", () => {
    const doc = render(`<input id="close" type="date" name="close_date">`);
    expect(isSecure(doc.getElementById("close")!)).toBe(false);
  });
});

describe("accessibleName", () => {
  it("resolves in spec order", () => {
    const doc = render(`
      <span id="lbl">From labelledby</span>
      <input id="a" aria-labelledby="lbl" aria-label="From aria-label">
      <input id="b" aria-label="From aria-label">
      <label for="c">From label for</label><input id="c">
      <label>Wrapping label<input id="d"></label>
      <input id="e" placeholder="From placeholder">
      <input id="f" title="From title">
      <input id="g" type="submit" value="From value">
      <button id="h">From text</button>
    `);
    const name = (id: string) => accessibleName(doc.getElementById(id)!);
    expect(name("a")).toBe("From labelledby");
    expect(name("b")).toBe("From aria-label");
    expect(name("c")).toBe("From label for");
    expect(name("d")).toBe("Wrapping label");
    expect(name("e")).toBe("From placeholder");
    expect(name("f")).toBe("From title");
    expect(name("g")).toBe("From value");
    expect(name("h")).toBe("From text");
  });

  it("returns empty rather than guessing when nothing names the control", () => {
    const doc = render(`<input id="a">`);
    expect(accessibleName(doc.getElementById("a")!)).toBe("");
  });

  it("survives an id that is not a valid bare selector", () => {
    const doc = render(`<label for="a.b:c">Odd id</label><input id="a.b:c">`);
    expect(accessibleName(doc.querySelector("input")!)).toBe("Odd id");
  });
});

describe("readValue", () => {
  it("reads inputs, textareas, selects and checkboxes", () => {
    const doc = render(`
      <input id="a" value="2026-09-30">
      <textarea id="b">notes</textarea>
      <select id="c"><option>One</option><option selected>Two</option></select>
      <input id="d" type="checkbox" checked>
      <div id="e" role="checkbox" aria-checked="true"></div>
      <button id="f">Save</button>
    `);
    const value = (id: string) => readValue(doc.getElementById(id)!);
    expect(value("a")).toBe("2026-09-30");
    expect(value("b")).toBe("notes");
    expect(value("c")).toBe("Two");
    expect(value("d")).toBe("true");
    expect(value("e")).toBe("true");
    expect(value("f")).toBe("Save");
  });
});

describe("isHiddenByStyleOrAria", () => {
  it("finds hidden state on an ancestor, not just the element", () => {
    const doc = render(`
      <div style="display:none"><input id="a"></div>
      <div hidden><input id="b"></div>
      <div aria-hidden="true"><input id="c"></div>
      <div style="visibility:hidden"><input id="d"></div>
      <div><input id="ok"></div>
    `);
    for (const id of ["a", "b", "c", "d"]) {
      expect(isHiddenByStyleOrAria(doc.getElementById(id)!), id).toBe(true);
    }
    expect(isHiddenByStyleOrAria(doc.getElementById("ok")!)).toBe(false);
  });
});

describe("collectControls", () => {
  it("returns addressable controls with their bindings, skipping the rest", () => {
    const doc = render(`
      <label for="close">Close Date *</label><input id="close" type="date" value="2026-09-30">
      <input id="pw" type="password" aria-label="Password">
      <div style="display:none"><input id="gone" aria-label="Gone"></div>
      <input type="radio" aria-label="Ignored">
      <button>Save</button>
    `);
    const bindings = collectControls(doc);
    const names = bindings.map((b) => b.control.accessibleName);
    expect(names).toContain("Close Date *");
    expect(names).toContain("Save");
    expect(names).not.toContain("Ignored");

    const closeDate = bindings.find((b) => b.control.accessibleName === "Close Date *")!;
    expect(closeDate.control).toMatchObject({
      role: "textbox",
      value: "2026-09-30",
      editable: true,
      secure: false,
      visible: true,
    });

    // Present but marked, so the resolver refuses it rather than never seeing it.
    expect(bindings.find((b) => b.control.accessibleName === "Password")!.control.secure).toBe(
      true,
    );
    expect(bindings.find((b) => b.control.accessibleName === "Gone")!.control.visible).toBe(false);
  });

  it("marks disabled and readonly controls non-editable", () => {
    const doc = render(`
      <input id="a" aria-label="A" disabled>
      <input id="b" aria-label="B" readonly>
      <div id="c" role="textbox" aria-label="C" aria-disabled="true"></div>
      <div id="d" role="textbox" aria-label="D" aria-readonly="true"></div>
    `);
    const editable = (name: string) =>
      collectControls(doc).find((b) => b.control.accessibleName === name)!.control.editable;
    expect(editable("A")).toBe(false);
    expect(editable("B")).toBe(false);
    expect(editable("C")).toBe(false);
    expect(editable("D")).toBe(false);
  });
});

describe("applyAction", () => {
  it("sets a value and fires the events a framework-controlled field listens for", () => {
    const doc = render(`<input id="a" aria-label="Close date" value="2026-09-30">`);
    const el = doc.getElementById("a")!;
    const seen: string[] = [];
    el.addEventListener("input", () => seen.push("input"));
    el.addEventListener("change", () => seen.push("change"));

    const out = applyAction(
      {
        kind: "set_value",
        target: { role: "textbox", name: "Close date" },
        value: "2026-12-31",
      },
      el,
    );
    expect((el as HTMLInputElement).value).toBe("2026-12-31");
    expect(out.valueAfter).toBe("2026-12-31");
    expect(seen).toEqual(["input", "change"]);
  });

  it("selects an option by its visible text", () => {
    const doc = render(
      `<select id="s" aria-label="Stage"><option>Proposal</option><option>Closed Won</option></select>`,
    );
    const el = doc.getElementById("s")!;
    const out = applyAction(
      { kind: "select_option", target: { role: "combobox", name: "Stage" }, option: "closed won" },
      el,
    );
    expect(out.valueAfter).toBe("Closed Won");
  });

  it("leaves the control alone when the option does not exist", () => {
    const doc = render(`<select id="s" aria-label="Stage"><option>Proposal</option></select>`);
    const el = doc.getElementById("s")!;
    const out = applyAction(
      { kind: "select_option", target: { role: "combobox", name: "Stage" }, option: "Nope" },
      el,
    );
    expect(out.valueAfter).toBe("Proposal");
  });

  it("clicks, focuses, and reads", () => {
    const doc = render(`<button id="b">Save</button><input id="i" aria-label="A" value="v">`);
    const button = doc.getElementById("b")!;
    let clicks = 0;
    button.addEventListener("click", () => clicks++);
    applyAction(
      { kind: "click_control", target: { role: "button", name: "Save" }, confirm_name: "Save" },
      button,
    );
    expect(clicks).toBe(1);

    const input = doc.getElementById("i")!;
    input.scrollIntoView = () => {};
    expect(
      applyAction({ kind: "focus_field", target: { role: "textbox", name: "A" } }, input)
        .valueAfter,
    ).toBe("v");
    expect(doc.activeElement).toBe(input);
    expect(
      applyAction({ kind: "read_field", target: { role: "textbox", name: "A" } }, input).valueAfter,
    ).toBe("v");
  });
});
