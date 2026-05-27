(function(window) {
"use strict";

// === constants.js ===
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MATH_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// === elementTags.js ===
// Create a Map for faster lookups
const KNOWN_ELEMENTS = new Map(Object.entries({
    a: "A",
    abbr: "ABBR",
    address: "ADDRESS",
    area: "AREA",
    article: "ARTICLE",
    aside: "ASIDE",
    audio: "AUDIO",
    b: "B",
    base: "BASE",
    bdi: "BDI",
    bdo: "BDO",
    blockquote: "BLOCKQUOTE",
    body: "BODY",
    br: "BR",
    button: "BUTTON",
    canvas: "CANVAS",
    caption: "CAPTION",
    cite: "CITE",
    code: "CODE",
    col: "COL",
    colgroup: "COLGROUP",
    data: "DATA",
    datalist: "DATALIST",
    dd: "DD",
    del: "DEL",
    details: "DETAILS",
    dfn: "DFN",
    dialog: "DIALOG",
    div: "DIV",
    dl: "DL",
    dt: "DT",
    em: "EM",
    embed: "EMBED",
    fieldset: "FIELDSET",
    figcaption: "FIGCAPTION",
    figure: "FIGURE",
    footer: "FOOTER",
    form: "FORM",
    h1: "H1",
    h2: "H2",
    h3: "H3",
    h4: "H4",
    h5: "H5",
    h6: "H6",
    head: "HEAD",
    header: "HEADER",
    hgroup: "HGROUP",
    hr: "HR",
    html: "HTML",
    i: "I",
    iframe: "IFRAME",
    img: "IMG",
    input: "INPUT",
    ins: "INS",
    kbd: "KBD",
    label: "LABEL",
    legend: "LEGEND",
    li: "LI",
    link: "LINK",
    main: "MAIN",
    map: "MAP",
    mark: "MARK",
    menu: "MENU",
    meta: "META",
    meter: "METER",
    nav: "NAV",
    noscript: "NOSCRIPT",
    object: "OBJECT",
    ol: "OL",
    optgroup: "OPTGROUP",
    option: "OPTION",
    output: "OUTPUT",
    p: "P",
    picture: "PICTURE",
    pre: "PRE",
    progress: "PROGRESS",
    q: "Q",
    rp: "RP",
    rt: "RT",
    ruby: "RUBY",
    s: "S",
    samp: "SAMP",
    script: "SCRIPT",
    section: "SECTION",
    select: "SELECT",
    slot: "SLOT",
    small: "SMALL",
    source: "SOURCE",
    span: "SPAN",
    strong: "STRONG",
    style: "STYLE",
    sub: "SUB",
    summary: "SUMMARY",
    sup: "SUP",
    table: "TABLE",
    tbody: "TBODY",
    td: "TD",
    template: "TEMPLATE",
    textarea: "TEXTAREA",
    tfoot: "TFOOT",
    th: "TH",
    thead: "THEAD",
    time: "TIME",
    title: "TITLE",
    tr: "TR",
    track: "TRACK",
    u: "U",
    ul: "UL",
    var: "VAR",
    video: "VIDEO",
    wbr: "WBR",
}));

// === utils.js ===
/**
 * Flattens nested virtual nodes by replacing Fragments with their children.
 * @param vnodes Virtual nodes to flatten
 * @returns Array of flattened virtual nodes
 */
function flattenVNodes(vnodes, result = []) {
    if (Array.isArray(vnodes)) {
        for (const vnode of vnodes) {
            flattenVNodes(vnode, result);
        }
    }
    else if (isValidVNode(vnodes)) {
        result.push(vnodes);
    }
    return result;
}
function isValidVNode(vnode) {
    const typeofVNode = typeof vnode;
    return (vnode !== null &&
        vnode !== undefined &&
        (typeofVNode === "string" ||
            typeofVNode === "object" ||
            typeofVNode === "number" ||
            typeofVNode === "bigint"));
}
/* Get Child Nodes Efficiently */
function getChildNodes(parent) {
    const nodes = [];
    let current = parent.firstChild;
    while (current) {
        nodes.push(current);
        current = current.nextSibling;
    }
    return nodes;
}
/**
 * Assigns a ref to a DOM node.
 * @param node Target DOM node
 * @param ref Reference to assign (function or object with current property)
 */
function assignRef(node, ref) {
    if (typeof ref === "function") {
        ref(node);
    }
    else if (ref && typeof ref === "object") {
        ref.current = node;
    }
}
function isVElement(vnode) {
    const typeofVNode = typeof vnode;
    return (typeofVNode !== "string" &&
        typeofVNode !== "number" &&
        typeofVNode !== "bigint");
}
function isNonBooleanPrimitive(vnode) {
    const typeofVNode = typeof vnode;
    return (typeofVNode === "string" ||
        typeofVNode === "number" ||
        typeofVNode === "bigint");
}
function getNamespaceURI(node) {
    return node instanceof Element && node.namespaceURI !== HTML_NAMESPACE
        ? node.namespaceURI ?? undefined
        : undefined;
}
function setWebJSXProps(element, props) {
    element.__webjsx_props = props;
}
function getWebJSXProps(element) {
    let props = element.__webjsx_props;
    if (!props) {
        props = {};
        element.__webjsx_props = props;
    }
    return props;
}
function setWebJSXChildNodeCache(element, childNodes) {
    element.__webjsx_childNodes = childNodes;
}
function getWebJSXChildNodeCache(element) {
    return element.__webjsx_childNodes;
}

// === renderSuspension.js ===
function definesRenderSuspension(el) {
    return !!el.__webjsx_suspendRendering;
}
/**
 * Executes a callback with render suspension handling.
 * @param el Element that may have render suspension
 * @param callback Function to execute during suspension
 * @returns Result of the callback
 */
function withRenderSuspension(el, callback) {
    const isRenderingSuspended = !!el
        .__webjsx_suspendRendering;
    if (isRenderingSuspended) {
        el.__webjsx_suspendRendering();
    }
    try {
        return callback();
    }
    finally {
        if (isRenderingSuspended) {
            el.__webjsx_resumeRendering();
        }
    }
}

// === attributes.js ===
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Updates an event listener on an element.
 * @param el Target element
 * @param eventName Name of the event (without 'on' prefix)
 * @param newHandler New event handler function
 * @param oldHandler Previous event handler function
 */
function updateEventListener(el, eventName, newHandler, oldHandler) {
    if (oldHandler && oldHandler !== newHandler) {
        el.removeEventListener(eventName, oldHandler);
    }
    if (newHandler && oldHandler !== newHandler) {
        el.addEventListener(eventName, newHandler);
        el.__webjsx_listeners =
            el.__webjsx_listeners ?? {};
        el.__webjsx_listeners[eventName] = newHandler;
    }
}
/**
 * Updates a single property or attribute on an element.
 * @param el Target element
 * @param key Property or attribute name
 * @param value New value to set
 */
function updatePropOrAttr(el, key, value) {
    if (el instanceof HTMLElement) {
        if (key in el) {
            // Fast path: property exists on HTMLElement
            el[key] = value;
            return;
        }
        if (typeof value === "string") {
            el.setAttribute(key, value);
            return;
        }
        // Fallback for non-string values on HTMLElement
        el[key] = value;
        return;
    }
    // SVG/Other namespace elements
    const isSVG = el.namespaceURI === "http://www.w3.org/2000/svg";
    if (isSVG) {
        if (value !== undefined && value !== null) {
            el.setAttribute(key, `${value}`);
        }
        else {
            el.removeAttribute(key);
        }
        return;
    }
    // Fallback for other element types
    if (typeof value === "string") {
        el.setAttribute(key, value);
    }
    else {
        el[key] = value;
    }
}
/**
 * Updates all attributes and properties on a DOM element.
 * @param el Target element
 * @param newProps New properties to apply
 * @param oldProps Previous properties for comparison (default empty object)
 */
function updateAttributesCore(el, newProps, oldProps = {}) {
    // Handle new/updated props
    for (const key of Object.keys(newProps)) {
        const value = newProps[key];
        if (key === "children" ||
            key === "key" ||
            key === "dangerouslySetInnerHTML" ||
            key === "nodes")
            continue;
        if (key.startsWith("on") && typeof value === "function") {
            const eventName = key.substring(2).toLowerCase();
            updateEventListener(el, eventName, value, el.__webjsx_listeners?.[eventName]);
        }
        else if (value !== oldProps[key]) {
            updatePropOrAttr(el, key, value);
        }
    }
    // Handle dangerouslySetInnerHTML
    if (newProps.dangerouslySetInnerHTML) {
        if (!oldProps.dangerouslySetInnerHTML ||
            newProps.dangerouslySetInnerHTML.__html !==
                oldProps.dangerouslySetInnerHTML.__html) {
            const html = newProps.dangerouslySetInnerHTML?.__html || "";
            el.innerHTML = html;
        }
    }
    else {
        if (oldProps.dangerouslySetInnerHTML) {
            el.innerHTML = "";
        }
    }
    // Remove old props/attributes
    for (const key of Object.keys(oldProps)) {
        if (!(key in newProps) &&
            key !== "children" &&
            key !== "key" &&
            key !== "dangerouslySetInnerHTML" &&
            key !== "nodes") {
            if (key.startsWith("on")) {
                const eventName = key.substring(2).toLowerCase();
                const existingListener = el
                    .__webjsx_listeners?.[eventName];
                if (existingListener) {
                    el.removeEventListener(eventName, existingListener);
                    delete el.__webjsx_listeners[eventName];
                }
            }
            else if (key in el) {
                el[key] = undefined;
            }
            else {
                el.removeAttribute(key);
            }
        }
    }
}
/**
 * Sets initial attributes and properties on a DOM element.
 * @param el Target element
 * @param props Properties to apply
 */
function setAttributes(el, props) {
    if (definesRenderSuspension(el)) {
        withRenderSuspension(el, () => {
            updateAttributesCore(el, props);
        });
    }
    else {
        updateAttributesCore(el, props);
    }
}
/**
 * Updates existing attributes and properties on a DOM element.
 * @param el Target element
 * @param newProps New properties to apply
 * @param oldProps Previous properties for comparison
 */
function updateAttributes(el, newProps, oldProps) {
    if (definesRenderSuspension(el)) {
        withRenderSuspension(el, () => {
            updateAttributesCore(el, newProps, oldProps);
        });
    }
    else {
        updateAttributesCore(el, newProps, oldProps);
    }
}

// === createDOMElement.js ===
/**
 * Creates a real DOM node from a virtual node representation.
 * @param velement Virtual node to convert
 * @param parentNamespaceURI Namespace URI from parent element, if any
 * @returns Created DOM node
 */
function createDOMElement(velement, parentNamespaceURI) {
    const namespaceURI = velement.props.xmlns !== undefined
        ? velement.props.xmlns
        : velement.type === "svg"
            ? SVG_NAMESPACE
            : parentNamespaceURI ?? undefined;
    const el = velement.props.is !== undefined
        ? namespaceURI !== undefined
            ? document.createElementNS(namespaceURI, velement.type, {
                is: velement.props.is,
            })
            : document.createElement(velement.type, {
                is: velement.props.is,
            })
        : namespaceURI !== undefined
            ? document.createElementNS(namespaceURI, velement.type)
            : document.createElement(velement.type);
    if (velement.props) {
        setAttributes(el, velement.props);
    }
    if (velement.props.key !== undefined) {
        el.__webjsx_key = velement.props.key;
    }
    if (velement.props.ref) {
        assignRef(el, velement.props.ref);
    }
    if (velement.props.children && !velement.props.dangerouslySetInnerHTML) {
        const children = velement.props.children;
        const nodes = [];
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const node = isVElement(child)
                ? createDOMElement(child, namespaceURI)
                : document.createTextNode(`${child}`);
            nodes.push(node);
            el.appendChild(node);
        }
        setWebJSXProps(el, velement.props);
        setWebJSXChildNodeCache(el, nodes);
    }
    return el;
}

// === createElement.js ===
/**
 * Creates a virtual element representing a DOM node or Fragment.
 * @param type Element type (tag name) or Fragment
 * @param props Properties and attributes for the element
 * @param children Child elements or content
 * @returns Virtual element representation
 */
function createElement(type, props, ...children) {
    if (typeof type === "string") {
        const normalizedProps = props ? props : {};
        const flatChildren = flattenVNodes(children);
        if (flatChildren.length > 0) {
            // Set children property only if dangerouslySetInnerHTML is not present
            if (!normalizedProps.dangerouslySetInnerHTML) {
                normalizedProps.children = flatChildren;
            }
            else {
                normalizedProps.children = [];
                console.warn("WebJSX: Ignoring children since dangerouslySetInnerHTML is set.");
            }
        }
        else {
            normalizedProps.children = [];
        }
        const result = {
            type,
            tagName: KNOWN_ELEMENTS.get(type) ?? type.toUpperCase(),
            props: normalizedProps ?? {},
        };
        return result;
    }
    else {
        return flattenVNodes(children);
    }
}
// As called from jsx-runtime.jsx function.
function createElementJSX(type, props, key) {
    if (typeof type === "string") {
        props = props || {};
        const flatChildren = props
            ? flattenVNodes(props.children)
            : [];
        if (key !== undefined) {
            props.key = key;
        }
        if (flatChildren.length > 0) {
            // Set children property only if dangerouslySetInnerHTML is not present
            if (!props.dangerouslySetInnerHTML) {
                props.children = flatChildren;
            }
            else {
                props.children = [];
                console.warn("WebJSX: Ignoring children since dangerouslySetInnerHTML is set.");
            }
        }
        else {
            props.children = [];
        }
        const result = {
            type,
            tagName: KNOWN_ELEMENTS.get(type) ?? type.toUpperCase(),
            props: props ?? {},
        };
        return result;
    }
    else {
        const flatChildren = props
            ? flattenVNodes(props.children)
            : [];
        return flatChildren;
    }
}

// === applyDiff.js ===
function applyDiff(parent, vnodes) {
    const newVNodes = flattenVNodes(vnodes);
    const newNodes = diffChildren(parent, newVNodes);
    const props = getWebJSXProps(parent);
    props.children = newVNodes;
    setWebJSXChildNodeCache(parent, newNodes);
}
function diffChildren(parent, newVNodes) {
    const parentProps = getWebJSXProps(parent);
    const oldVNodes = parentProps.children ?? [];
    if (newVNodes.length === 0) {
        if (oldVNodes.length > 0) {
            parent.innerHTML = "";
            return [];
        }
        else {
            // If the parent
            // a) never had any nodes
            // b) OR was managing content via dangerouslySetInnerHTML
            // we must not set parent.innerHTML = "";
            return [];
        }
    }
    const changes = [];
    let keyedMap = null;
    const originalChildNodes = getWebJSXChildNodeCache(parent) ?? getChildNodes(parent);
    let hasKeyedNodes = false;
    let nodeOrderUnchanged = true;
    for (let i = 0; i < newVNodes.length; i++) {
        const newVNode = newVNodes[i];
        const oldVNode = oldVNodes[i];
        const currentNode = originalChildNodes[i];
        const newKey = isVElement(newVNode) ? newVNode.props.key : undefined;
        if (newKey !== undefined) {
            if (!keyedMap) {
                hasKeyedNodes = true;
                keyedMap = new Map();
                for (let j = 0; j < oldVNodes.length; j++) {
                    const matchingVNode = oldVNodes[j];
                    const key = matchingVNode.props.key;
                    if (key !== undefined) {
                        const node = originalChildNodes[j];
                        keyedMap.set(key, { node, oldVNode: matchingVNode });
                    }
                }
            }
            const keyedNode = keyedMap.get(newKey);
            if (keyedNode) {
                if (keyedNode.oldVNode !== oldVNode) {
                    nodeOrderUnchanged = false;
                }
                changes.push({
                    type: "update",
                    node: keyedNode.node,
                    newVNode,
                    oldVNode: keyedNode.oldVNode,
                });
            }
            else {
                nodeOrderUnchanged = false;
                changes.push({ type: "create", vnode: newVNode });
            }
        }
        else {
            if (!hasKeyedNodes &&
                canUpdateVNodes(newVNode, oldVNode) &&
                currentNode) {
                changes.push({
                    type: "update",
                    node: currentNode,
                    newVNode,
                    oldVNode,
                });
            }
            else {
                nodeOrderUnchanged = false;
                changes.push({ type: "create", vnode: newVNode });
            }
        }
    }
    if (changes.length) {
        const { nodes, lastNode: lastPlacedNode } = applyChanges(parent, changes, originalChildNodes, nodeOrderUnchanged);
        // Remove any remaining nodes
        while (lastPlacedNode?.nextSibling) {
            parent.removeChild(lastPlacedNode.nextSibling);
        }
        return nodes;
    }
    else {
        return originalChildNodes;
    }
}
function canUpdateVNodes(newVNode, oldVNode) {
    if (oldVNode === undefined)
        return false;
    if (isNonBooleanPrimitive(newVNode) && isNonBooleanPrimitive(oldVNode)) {
        return true;
    }
    else {
        if (isVElement(oldVNode) && isVElement(newVNode)) {
            const oldKey = oldVNode.props.key;
            const newKey = newVNode.props.key;
            return (oldVNode.tagName === newVNode.tagName &&
                ((oldKey === undefined && newKey === undefined) ||
                    (oldKey !== undefined && newKey !== undefined && oldKey === newKey)));
        }
        else {
            return false;
        }
    }
}
function applyChanges(parent, changes, originalNodes, nodeOrderUnchanged) {
    const nodes = [];
    let lastPlacedNode = null;
    for (const change of changes) {
        if (change.type === "create") {
            let node = undefined;
            if (isVElement(change.vnode)) {
                node = createDOMElement(change.vnode, getNamespaceURI(parent));
            }
            else {
                node = document.createTextNode(`${change.vnode}`);
            }
            if (!lastPlacedNode) {
                parent.prepend(node);
            }
            else {
                parent.insertBefore(node, lastPlacedNode.nextSibling ?? null);
            }
            lastPlacedNode = node;
            nodes.push(node);
        }
        else {
            const { node, newVNode, oldVNode } = change;
            if (isVElement(newVNode)) {
                const oldProps = oldVNode?.props || {};
                const newProps = newVNode.props;
                updateAttributes(node, newProps, oldProps);
                if (newVNode.props.key !== undefined) {
                    node.__webjsx_key = newVNode.props.key;
                }
                else {
                    if (oldVNode.props?.key) {
                        delete node.__webjsx_key;
                    }
                }
                if (newVNode.props.ref) {
                    assignRef(node, newVNode.props.ref);
                }
                if (!newProps.dangerouslySetInnerHTML && newProps.children != null) {
                    const childNodes = diffChildren(node, newProps.children);
                    setWebJSXProps(node, newProps);
                    setWebJSXChildNodeCache(node, childNodes);
                }
            }
            else {
                if (newVNode !== oldVNode) {
                    node.textContent = `${newVNode}`;
                }
            }
            if (!nodeOrderUnchanged) {
                if (!lastPlacedNode) {
                    if (node !== originalNodes[0]) {
                        parent.prepend(node);
                    }
                }
                else {
                    if (lastPlacedNode.nextSibling !== node) {
                        parent.insertBefore(node, lastPlacedNode.nextSibling ?? null);
                    }
                }
            }
            lastPlacedNode = node;
            nodes.push(node);
        }
    }
    return { nodes, lastNode: lastPlacedNode };
}

// === types.js ===
const Fragment = (props) => {
    return flattenVNodes(props.children);
};

window.webjsx = { createElement, applyDiff, createDOMElement, Fragment };
})(typeof window !== 'undefined' ? window : globalThis);
