// The opening comments read from each language, and what folders say they are (server/headers.ts). Run: npm test

import assert from 'node:assert/strict'
import test from 'node:test'
import { readmeSummary, speakers, summaryOf } from '../server/headers.ts'

const W = 'Says what it does.'
const L = '/*\n * Copyright 2020 Foo\n * Licensed under the Apache License, Version 2.0;\n * you may not use this file except in compliance.\n */\n'
// name, contents, the summary expected
const CASES: [string, string, string][] = [
  ['a.ts',`'use client'\n// ${W}\nimport x`,W],
  ['b.ts','/** Anything with size here. */\nexport interface A{}\nexport const b=1',''],
  ['c.ts',`/**\n * @fileoverview ${W}\n * @author Me\n */\nimport x`,W],
  ['d.ts',`import x from 'y'\n\n/** Does one small thing. */\nconst a=1`,''],
  ['A.java',`${L}package a.b;\n\nimport java.util.*;\n\n/**\n * ${W}\n * @since 1\n */\n@Foo("x")\npublic final class A {}`,W],
  ['A.cs',`using System;\n\nnamespace X\n{\n    /// <summary>\n    /// ${W}\n    /// </summary>\n    [Foo]\n    public sealed class A {}\n}`,W],
  ['A.kt',`@file:JvmName("x")\npackage a\nimport b\n\n/** ${W} */\ndata class A(val x:Int)`,W],
  ['A.swift',`//\n//  A.swift\n//  MyApp\n//\n//  Created by Sam on 1/1/20.\n//  Copyright © 2020 Sam. All rights reserved.\n//\n\nimport UIKit\n\n/// ${W}\nfinal class A {}`,W],
  ['A.scala',`package a\n/** ${W} */\nobject A`,W],
  ['a.dart',`import 'x';\n\n/// ${W}\nclass A {}`,W],
  ['a.php',`<?php\n\ndeclare(strict_types=1);\n\nnamespace A;\n\nuse B;\n\n/**\n * ${W}\n */\nclass A {}`,W],
  ['a.c',`${L}#include <x.h>\n\n/* ${W} */\nint x;`,W],
  ['a.h',`#ifndef A_H\n#define A_H\n// ${W}\n`,W],
  ['a2.h',`#include <x.h>\nint a;`,''],
  ['a.cpp',`/// \\file\n/// \\brief ${W}\n#include <x>`,W],
  ['a.go',`// Copyright 2009 The Go Authors. All rights reserved.\n// Use of this source code is governed by a BSD-style\n// license.\n\n//go:build linux\n\n// ${W}\npackage a`,W],
  ['a.rs',`#![allow(x)]\n//! ${W}\n\nuse x;`,W],
  ['b.rs','#[derive(Debug)]\nstruct A;',''],
  ['a.py',`#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n# Copyright 2020 Me\nr"""${W}\n\nMore here for you.\n"""\nimport x`,W],
  ['b.py',`# ${W}\nimport x`,W],
  ['a.rb',`# frozen_string_literal: true\n\nrequire 'x'\n\n# ${W}\nclass A\nend`,W],
  ['b.rb',`=begin\n${W}\n=end`,W],
  ['a.pl',`#!/usr/bin/perl\nuse strict;\n# ${W}\n`,W],
  ['a.ex',`defmodule A do\n  @moduledoc """\n  ${W}\n  """\n`,W],
  ['a.ps1',`<#\n.SYNOPSIS\n${W}\n#>`,W],
  ['a.jl',`#=\n${W}\n=#`,W],
  ['a.nim',`## ${W}`,W],
  ['a.coffee',`###\n${W}\n###`,W],
  ['a.cmake',`# ${W}`,W],
  ['a.sh',`#!/bin/bash\n#\n# ${W}\nset -e`,W],
  ['Dockerfile',`# syntax=docker/dockerfile:1\n# ${W}\nFROM x`,W],
  ['Makefile',`# ${W}`,W],
  ['a.yml',`---\n# ${W}`,W],
  ['a.toml',`# ${W}`,W],
  ['a.R',`#' ${W}`,W],
  ['a.tf',`# ${W}`,W],
  ['a.nix',`/* ${W} */`,W],
  ['a.graphql',`# ${W}`,W],
  ['a.sql',`-- ${W}\nselect 1`,W],
  ['a.lua',`--[[\n${W}\n]]`,W],
  ['b.lua',`-- ${W}`,W],
  ['a.hs',`{-# LANGUAGE X #-}\n{- |\n${W}\n-}\nmodule A`,W],
  ['a.elm',`module A exposing (..)\n\n{-| ${W}\n-}`,W],
  ['a.ml',`(** ${W} *)`,W],
  ['a.fs',`module A\n\n/// ${W}\ntype A = int`,W],
  ['a.pas',`{ ${W} }`,W],
  ['a.clj',`;; ${W}\n(ns a)`,W],
  ['a.el',`;;; a.el --- ${W}`,W],
  ['a.asm',`; ${W}`,W],
  ['a.erl',`%%% ${W}\n-module(a).`,W],
  ['a.tex',`% ${W}`,W],
  ['a.vb',`Imports X\n''' <summary>\n''' ${W}\n''' </summary>\nPublic Class A`,W],
  ['a.bat',`@echo off\nREM ${W}`,W],
  ['a.f90',`! ${W}`,W],
  ['a.vim',`" ${W}`,W],
  ['a.vue',`<!-- ${W} -->\n<template>`,W],
  ['b.vue',`<script setup lang="ts">\n// ${W}\nimport x`,W],
  ['a.svelte',`<script>\n  // ${W}`,W],
  ['a.astro',`---\n// ${W}\n---`,W],
  ['a.html',`<!doctype html>\n<!-- ${W} -->`,W],
  ['a.xml',`<?xml version="1.0"?>\n<!--\n ${W}\n-->`,W],
  ['a.css',`/* ${W} */\n* {}`,W],
  ['b.css','#id { color:red }',''],
  ['a.scss',`// ${W}`,W],
  ['a.proto',`syntax = "proto3";\n// ${W}`,W],
  ['a.sol',`// SPDX-License-Identifier: MIT\npragma solidity ^0.8;\n\n/// @title ${W}\ncontract`,''],
  ['a.zig',`//! ${W}`,W],
  ['a.erb',`<%# ${W} %>`,W],
  ['a.hbs',`{{!-- ${W} --}}`,W],
  ['a.j2',`{# ${W} #}`,W],
  ['a.cshtml',`@page\n@* ${W} *@`,W],
  ['a.vhd',`-- ${W}`,W],
  ['a.groovy',`// ${W}`,W],
  ['empty.ts','',''],
  ['x.unknown','// hi there you',''],
  ['open.ts','/* never closed comment',''],
  ['min.js','x'.repeat(100000),''],
]

for (const [i, [name, text, want]] of CASES.entries()) test(`opening comment ${i + 1}: ${name}`, () => assert.equal(summaryOf(text, name), want))

test("a README's first paragraph, without its markup", () => {
  const cases: [string, string][] = [
    ['# Title\n\n[![ci](a.svg)](b) ![x](y)\n\nIt **does** [one](u) `thing` well.\nAnd more.\n\nNext.', 'It does one thing well. And more.'],
    ['Title of this thing\n===================\n\nSays what it does.', W],
    ['---\ntitle: x\n---\n<!-- note to self here -->\n<p align="center">Says what it does.</p>', W],
    ['# A\n\n```\nnpm install this thing\n```\n\n- a list of things\n\nSays what it does.', W],
    ['# Only a title', ''],
    ['', ''],
  ]
  for (const [text, want] of cases) assert.equal(readmeSummary(text), want)
})

test('a README speaks for its folder before an index file does', () => {
  const s = speakers(['a/index.ts', 'a/README.md', 'a/b/mod.rs', 'README.md', 'a/c.ts', 'p/__init__.py'])
  assert.deepEqual([...s], [['a', ['a/README.md', 'a/index.ts']], ['a/b', ['a/b/mod.rs']], ['p', ['p/__init__.py']]])
})
