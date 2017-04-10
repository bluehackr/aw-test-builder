#!/bin/bash
apex deploy build && apex invoke build < functions/build/input.json
