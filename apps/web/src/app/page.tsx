"use client";
import Image from "next/image";
import { useState } from "react";
import { Block } from "@repo/core";

const blockB: Block = { content: "hihi" };
const blockA: Block = { content: "haha", next: blockB };

export default function Home() {
  const [graph, setGraph] = useState<Block[]>([blockA, blockB]);
  if (!graph) return null;

  return graph.map((node) => node.content);
}
