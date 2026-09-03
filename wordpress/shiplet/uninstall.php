<?php
/**
 * Remove Shiplet's local installation record on uninstall.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'shiplet_embed_installation' );
