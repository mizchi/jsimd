export class FakeNode {
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  data = "";
  textContentWrites = 0;
  tagName = "";

  constructor(data = "") {
    this.data = data;
  }

  get textContent(): string {
    return this.childNodes.length === 0
      ? this.data
      : this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.textContentWrites++;
    this.childNodes.splice(0);
    this.data = value;
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("child not found");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild<T extends FakeNode>(next: T, previous: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(previous);
    if (index < 0) throw new Error("child not found");
    previous.parentNode = null;
    next.parentNode = this;
    this.childNodes[index] = next;
    return previous;
  }

  setAttribute(name: string, value: string): void {
    if (name === "class") this.tagName = value;
  }
}

export class FakeDocument {
  createElement(tagName: string, data = ""): FakeNode {
    const node = new FakeNode(data);
    node.tagName = tagName;
    return node;
  }

  createTextNode(data: string): FakeNode {
    return new FakeNode(data);
  }
}
