/* eslint import/prefer-default-export: off */
import { ClientFunction } from 'testcafe';

export const getPageUrl = ClientFunction(() => window.location.href);
export const getPageTitle = ClientFunction(() => document.title);
